#include <WiFi.h>
#include <Wire.h>
#include <Adafruit_INA219.h>
#include <LiquidCrystal_I2C.h>
#include <PubSubClient.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <time.h>
#include <esp_system.h>
#include <Preferences.h>

// ================= CẤU HÌNH HỆ THỐNG =================
const char* wifi_ssids[] = {"YOUR_WIFI_SSID"};
const char* wifi_passwords[] = {"YOUR_WIFI_PASSWORD"};
const size_t wifi_network_count = sizeof(wifi_ssids) / sizeof(wifi_ssids[0]);

// Broker chay tren may tinh cung Wi-Fi. Backend doc broker nay tai 127.0.0.1:1884.
const char* mqtt_server = "192.168.1.10";
const int   mqtt_port = 1885;
const char* mqtt_username = "solar_edge";
const char* mqtt_password = "YOUR_MQTT_PASSWORD";
const char* telemetry_topic = "solar/home_01/telemetry";
const char* control_topic = "solar/home_01/control";
const char* actuator_topic = "solar/home_01/actuator";
const char* actuator_status_topic = "solar/home_01/actuator/status";
const char* household_id = "home_01";
const uint32_t telemetry_interval_seconds = 300;
const uint32_t demo_publish_period_ms = 5000;
const uint32_t demo_samples_per_scenario = 12;
const float panel_rated_power_w = 3.0f;
WiFiClient espClient;
PubSubClient client(espClient);
Preferences preferences;

// Cấu hình thời gian NTP (Giờ Việt Nam UTC+7)
const char* ntpServer = "pool.ntp.org";
const char* ntpServerBackup1 = "time.google.com";
const char* ntpServerBackup2 = "time.cloudflare.com";
const long  gmtOffset_sec = 7 * 3600; 
const int   daylightOffset_sec = 0;

// ================= CẤU HÌNH PHẦN CỨNG =================
// 1. INA219 
Adafruit_INA219 ina219_phat(0x40);    // Module 1 (Nguồn phát - Ps)
Adafruit_INA219 ina219_tieuthu(0x41); // Module 2 (Tải tiêu thụ - Pl)

// 2. LCD 16x02
LiquidCrystal_I2C lcd(0x27, 16, 2); 

// 3. Relay (Kích mức LOW)
#define RELAY1_PIN  4   // Tải nội bộ (Quạt/LED)
#define RELAY2_PIN  25  // Lưới P2P (Bán điện)
#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif

// 4. Cảm biến nhiệt độ tấm pin DS18B20
#define ONE_WIRE_BUS 27
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature ds18b20(&oneWire);

// ================= BIẾN TOÀN CỤC & MUTEX =================
uint32_t sample_id = 0;
char run_id[33] = {0};

enum DemoScenario : uint8_t { DEMO_AUTO, DEMO_SELL, DEMO_BUY, DEMO_HOLD };
enum ActuatorState : uint8_t { ACTUATOR_OFF, ACTUATOR_SELL, ACTUATOR_BUY };
volatile bool demo_mode = false;
volatile DemoScenario demo_scenario = DEMO_AUTO;
volatile DemoScenario active_demo_scenario = DEMO_SELL;
time_t demo_timestamp = 0;
unsigned long last_demo_publish_ms = 0;
volatile ActuatorState actuator_state = ACTUATOR_OFF;
volatile unsigned long actuator_until_ms = 0;
volatile uint32_t actuator_round_id = 0;
bool lcd_available = false;
bool solar_meter_available = false;
bool load_meter_available = false;
bool temperature_sensor_available = false;

float v_solar = 0.0, i_solar = 0.0, p_solar = 0.0;
float v_load = 0.0,  i_load = 0.0,  p_load = 0.0;
float temp_panel = 0.0;
float p_du = 0.0;

double interval_solar_w_sum = 0.0;
double interval_load_w_sum = 0.0;
double interval_temperature_sum = 0.0;
uint32_t interval_power_samples = 0;
uint32_t interval_temperature_samples = 0;
time_t active_interval_start = 0;
bool interval_ready = false;

SemaphoreHandle_t dataMutex;

void createRunId();

bool i2cDevicePresent(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

const char* demoScenarioName(DemoScenario scenario) {
  switch (scenario) {
    case DEMO_SELL: return "sell";
    case DEMO_BUY: return "buy";
    case DEMO_HOLD: return "hold";
    default: return "auto";
  }
}

const char* actuatorStateName(ActuatorState state) {
  return state == ACTUATOR_SELL ? "sell" : (state == ACTUATOR_BUY ? "buy" : "off");
}

void publishActuatorAck(const char* state) {
  if (!client.connected()) return;
  char ack[320];
  bool relay1On = digitalRead(RELAY1_PIN) == LOW;
  bool relay2On = digitalRead(RELAY2_PIN) == LOW;
  int length = snprintf(ack, sizeof(ack),
    "{\"schema_version\":1,\"household_id\":\"%s\",\"run_id\":\"%s\","
    "\"round_id\":%lu,\"action\":\"%s\",\"relay1_on\":%s,\"relay2_on\":%s,\"state\":\"%s\"}",
    household_id, run_id, static_cast<unsigned long>(actuator_round_id),
    actuatorStateName(actuator_state), relay1On ? "true" : "false",
    relay2On ? "true" : "false", state);
  if (length > 0 && length < static_cast<int>(sizeof(ack)))
    client.publish(actuator_status_topic, ack, false);
}

void setActuatorOff(const char* reason, bool publishAck = true) {
  digitalWrite(RELAY1_PIN, HIGH);
  digitalWrite(RELAY2_PIN, HIGH);
  digitalWrite(LED_BUILTIN, LOW);
  actuator_state = ACTUATOR_OFF;
  actuator_until_ms = 0;
  Serial.printf("ACTUATOR OFF: %s\n", reason);
  if (publishAck) publishActuatorAck("timeout");
}

void applySettledActuator(const char* action, uint32_t roundId, uint32_t durationSeconds) {
  if (!demo_mode || roundId == 0 || durationSeconds < 1 || durationSeconds > 60) {
    Serial.println("Actuator command rejected");
    return;
  }
  actuator_round_id = roundId;
  actuator_until_ms = millis() + durationSeconds * 1000UL;
  if (strcmp(action, "sell") == 0) {
    // Export: disconnect the simulated local load and connect the P2P path.
    actuator_state = ACTUATOR_SELL;
    digitalWrite(RELAY1_PIN, HIGH);
    digitalWrite(RELAY2_PIN, LOW);
    digitalWrite(LED_BUILTIN, HIGH);
  } else if (strcmp(action, "buy") == 0) {
    // Import: connect the P2P path and the simulated local load.
    actuator_state = ACTUATOR_BUY;
    digitalWrite(RELAY1_PIN, LOW);
    digitalWrite(RELAY2_PIN, LOW);
  } else {
    Serial.println("Unknown actuator action");
    return;
  }
  Serial.printf("ACTUATOR APPLIED round=%lu action=%s duration=%lus relay1=%s relay2=%s\n",
                static_cast<unsigned long>(roundId), action,
                static_cast<unsigned long>(durationSeconds),
                digitalRead(RELAY1_PIN) == LOW ? "ON" : "OFF",
                digitalRead(RELAY2_PIN) == LOW ? "ON" : "OFF");
  publishActuatorAck("applied");
}

void updateActuator() {
  if (actuator_state != ACTUATOR_OFF &&
      static_cast<int32_t>(millis() - actuator_until_ms) >= 0) {
    setActuatorOff("transfer window completed");
    return;
  }
  if (actuator_state == ACTUATOR_BUY) {
    digitalWrite(LED_BUILTIN, (millis() / 250) % 2 ? HIGH : LOW);
  }
}

float randomFloat(float minimum, float maximum) {
  float unit = static_cast<float>(esp_random()) / static_cast<float>(UINT32_MAX);
  return minimum + unit * (maximum - minimum);
}

DemoScenario scenarioForSample(uint32_t sequence) {
  DemoScenario selected = demo_scenario;
  if (selected != DEMO_AUTO) return selected;
  uint32_t phase = (sequence / demo_samples_per_scenario) % 3;
  return phase == 0 ? DEMO_SELL : (phase == 1 ? DEMO_BUY : DEMO_HOLD);
}

void resetTelemetryRun() {
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(250))) {
    createRunId();
    sample_id = 0;
    interval_solar_w_sum = 0.0;
    interval_load_w_sum = 0.0;
    interval_temperature_sum = 0.0;
    interval_power_samples = 0;
    interval_temperature_samples = 0;
    active_interval_start = 0;
    interval_ready = false;
    demo_timestamp = 0;
    last_demo_publish_ms = 0;
    active_demo_scenario = scenarioForSample(0);
    xSemaphoreGive(dataMutex);
  }
  Serial.printf("Telemetry run_id: %s\n", run_id);
}

void setDemoMode(bool enabled) {
  if (!enabled) setActuatorOff("demo disabled");
  demo_mode = enabled;
  preferences.putBool("demo_mode", enabled);
  resetTelemetryRun();
  Serial.printf("DEMO_MODE=%s; publish=%lus; scenario=%s\n",
                enabled ? "ON" : "OFF",
                static_cast<unsigned long>(enabled ? demo_publish_period_ms / 1000 : telemetry_interval_seconds),
                demoScenarioName(demo_scenario));
}

void setDemoScenario(DemoScenario scenario) {
  if (scenario == DEMO_HOLD) setActuatorOff("HOLD scenario");
  demo_scenario = scenario;
  preferences.putUChar("demo_scenario", static_cast<uint8_t>(scenario));
  resetTelemetryRun();
  Serial.printf("Demo scenario=%s\n", demoScenarioName(scenario));
}

void printDemoHelp() {
  Serial.println("Commands: demo on | demo off | demo status | demo scenario auto|sell|buy|hold");
}

void handleSerialCommand(String command) {
  command.trim();
  command.toLowerCase();
  if (command == "demo on") setDemoMode(true);
  else if (command == "demo off") setDemoMode(false);
  else if (command == "demo status") {
    Serial.printf("DEMO_MODE=%s scenario=%s active=%s run_id=%s sequence=%lu\n",
                  demo_mode ? "ON" : "OFF", demoScenarioName(demo_scenario),
                  demoScenarioName(active_demo_scenario), run_id,
                  static_cast<unsigned long>(sample_id));
    Serial.printf("ACTUATOR=%s round=%lu relay1=%s relay2=%s\n",
                  actuatorStateName(actuator_state), static_cast<unsigned long>(actuator_round_id),
                  digitalRead(RELAY1_PIN) == LOW ? "ON" : "OFF",
                  digitalRead(RELAY2_PIN) == LOW ? "ON" : "OFF");
  } else if (command == "demo scenario auto") setDemoScenario(DEMO_AUTO);
  else if (command == "demo scenario sell") setDemoScenario(DEMO_SELL);
  else if (command == "demo scenario buy") setDemoScenario(DEMO_BUY);
  else if (command == "demo scenario hold") setDemoScenario(DEMO_HOLD);
  else if (command.length() > 0) printDemoHelp();
}

void mqttControlCallback(char* topic, byte* payload, unsigned int length) {
  if (length == 0 || length > 95) return;
  char command[96];
  memcpy(command, payload, length);
  command[length] = '\0';
  if (strcmp(topic, control_topic) == 0) {
    Serial.printf("MQTT control: %s\n", command);
    handleSerialCommand(String(command));
  } else if (strcmp(topic, actuator_topic) == 0) {
    char action[5] = {0};
    unsigned long roundId = 0, duration = 0;
    if (sscanf(command, "settled:%4[^:]:%lu:%lu", action, &roundId, &duration) == 3)
      applySettledActuator(action, static_cast<uint32_t>(roundId), static_cast<uint32_t>(duration));
    else
      Serial.println("Invalid actuator command");
  }
}

float clampValue(float value, float minimum, float maximum) {
  return value < minimum ? minimum : (value > maximum ? maximum : value);
}

void createRunId() {
  for (int part = 0; part < 4; part++) {
    snprintf(run_id + part * 8, 9, "%08lx", static_cast<unsigned long>(esp_random()));
  }
  run_id[32] = '\0';
}

void formatLocalTimestamp(time_t epoch, char* output, size_t length) {
  // Dung gmtime voi offset co dinh de chuoi luon dung +07:00, khong phu thuoc TZ cua runtime.
  time_t vietnamEpoch = epoch + gmtOffset_sec;
  struct tm parts;
  gmtime_r(&vietnamEpoch, &parts);
  strftime(output, length, "%Y-%m-%dT%H:%M:%S+07:00", &parts);
}

void formatUtcTimestamp(time_t epoch, char* output, size_t length) {
  struct tm parts;
  gmtime_r(&epoch, &parts);
  strftime(output, length, "%Y-%m-%dT%H:%M:%S+00:00", &parts);
}

float estimateIrradiance(float solarPowerW) {
  if (panel_rated_power_w <= 0.0f) return 0.0f;
  return clampValue(solarPowerW / panel_rated_power_w * 1000.0f, 0.0f, 1500.0f);
}

float estimateCloudCover(float irradiance, time_t intervalStart) {
  time_t midpoint = intervalStart + telemetry_interval_seconds / 2 + gmtOffset_sec;
  struct tm parts;
  gmtime_r(&midpoint, &parts);
  float hour = parts.tm_hour + parts.tm_min / 60.0f + parts.tm_sec / 3600.0f;
  if (hour <= 6.0f || hour >= 18.0f) return 0.0f;
  float daylight = sinf(PI * (hour - 6.0f) / 12.0f);
  float clearSky = 1000.0f * daylight;
  if (clearSky < 1.0f) return 0.0f;
  return clampValue((1.0f - irradiance / clearSky) / 0.75f, 0.0f, 1.0f);
}

// ================= TASK 1: ĐỌC CẢM BIẾN (Mỗi 500ms) =================
void TaskSensor(void *pvParameters) {
  for (;;) {
    float v1, i1, p1, v2, i2, p2, tp;
    if (demo_mode) {
      DemoScenario scenario = scenarioForSample(sample_id);
      active_demo_scenario = scenario;

      // Household-scale virtual inverter values for exercising buy/sell policy.
      // Voltage/current are derived from power so the fields remain consistent.
      float solarKw, loadKw;
      if (scenario == DEMO_SELL) {
        solarKw = randomFloat(2.2f, 4.0f);
        loadKw = randomFloat(0.35f, 1.10f);
      } else if (scenario == DEMO_BUY) {
        solarKw = randomFloat(0.0f, 0.45f);
        loadKw = randomFloat(1.6f, 3.8f);
      } else {
        float base = randomFloat(0.45f, 1.50f);
        solarKw = base;
        loadKw = max(0.05f, base + randomFloat(-0.08f, 0.08f));
      }
      v1 = randomFloat(218.0f, 242.0f);
      v2 = randomFloat(218.0f, 242.0f);
      p1 = solarKw * 1000000.0f; // mW, matching the INA219 API below.
      p2 = loadKw * 1000000.0f;
      i1 = solarKw * 1000.0f / v1 * 1000.0f; // mA
      i2 = loadKw * 1000.0f / v2 * 1000.0f;  // mA
      tp = randomFloat(24.0f + solarKw * 4.0f, 30.0f + solarKw * 7.0f);
    } else {
      v1 = solar_meter_available ? ina219_phat.getBusVoltage_V() : 0.0f;
      i1 = solar_meter_available ? ina219_phat.getCurrent_mA() : 0.0f;
      p1 = solar_meter_available ? ina219_phat.getPower_mW() : 0.0f;
      v2 = load_meter_available ? ina219_tieuthu.getBusVoltage_V() : 0.0f;
      i2 = load_meter_available ? ina219_tieuthu.getCurrent_mA() : 0.0f;
      p2 = load_meter_available ? ina219_tieuthu.getPower_mW() : 0.0f;
      if (temperature_sensor_available) {
        ds18b20.requestTemperatures();
        tp = ds18b20.getTempCByIndex(0);
      } else {
        tp = DEVICE_DISCONNECTED_C;
      }
    }

    // Cập nhật dữ liệu vào biến toàn cục qua Mutex
    if (xSemaphoreTake(dataMutex, portMAX_DELAY)) {
      v_solar = isfinite(v1) ? v1 : 0.0f;
      i_solar = isfinite(i1) ? i1 : 0.0f;
      p_solar = isfinite(p1) ? max(0.0f, p1 / 1000.0f) : 0.0f;
      v_load  = isfinite(v2) ? v2 : 0.0f;
      i_load  = isfinite(i2) ? i2 : 0.0f;
      p_load  = isfinite(p2) ? max(0.0f, p2 / 1000.0f) : 0.0f;
      
      p_du = p_solar - p_load;
      
      bool validTemperature = isfinite(tp) && tp != DEVICE_DISCONNECTED_C;
      if (validTemperature) {
        temp_panel = tp;
      }
      if (interval_ready) {
        interval_solar_w_sum += p_solar;
        interval_load_w_sum += p_load;
        interval_power_samples++;
        if (validTemperature) {
          interval_temperature_sum += tp;
          interval_temperature_samples++;
        }
      }
      xSemaphoreGive(dataMutex);
    }
    vTaskDelay(500 / portTICK_PERIOD_MS);
  }
}

// ================= TASK 2: HIỂN THỊ & ĐIỀU KHIỂN (Mỗi 500ms) =================
void TaskDisplay(void *pvParameters) {
  for (;;) {
    if (!lcd_available) {
      vTaskDelay(1000 / portTICK_PERIOD_MS);
      continue;
    }
    float lp_sol, lp_lod, lp_du;
    
    if (xSemaphoreTake(dataMutex, portMAX_DELAY)) {
      lp_sol = p_solar; lp_lod = p_load; lp_du = p_du;
      xSemaphoreGive(dataMutex);
    }

    lcd.setCursor(0, 0);
    lcd.printf("Ps:%.2f Pl:%.2f  ", lp_sol, lp_lod);
    
    lcd.setCursor(0, 1);
    if (lp_du > 0.05) {
      lcd.printf("Pdu:+%.2f SELL ", lp_du);
    } else if (lp_du < -0.05) {
      lcd.printf("Pdu:%.2f BUY   ", lp_du);
    } else {
      lcd.printf("Pdu:0.00 BAL   ");
    }

    vTaskDelay(500 / portTICK_PERIOD_MS);
  }
}

bool publishTelemetryRecord(time_t measuredEpoch, time_t publishedEpoch,
                            float solarPowerW, float loadPowerW, float temperature,
                            float solarVoltageV, float solarCurrentMa,
                            float loadVoltageV, float loadCurrentMa,
                            bool simulated, DemoScenario scenario, uint32_t powerSamples) {
  float solarPowerKw = roundf(solarPowerW / 1000.0f * 1000000.0f) / 1000000.0f;
  float loadPowerKw = roundf(loadPowerW / 1000.0f * 1000000.0f) / 1000000.0f;
  float netPowerKw = solarPowerKw - loadPowerKw;
  float solarEnergyKwh = solarPowerKw * telemetry_interval_seconds / 3600.0f;
  float loadEnergyKwh = loadPowerKw * telemetry_interval_seconds / 3600.0f;
  float surplusEnergyKwh = max(netPowerKw, 0.0f) * telemetry_interval_seconds / 3600.0f;
  float deficitEnergyKwh = max(-netPowerKw, 0.0f) * telemetry_interval_seconds / 3600.0f;
  float irradiance = simulated
    ? clampValue(solarPowerKw / 4.0f * 1000.0f, 0.0f, 1000.0f)
    : estimateIrradiance(solarPowerW);
  float cloudCover = simulated
    ? clampValue(1.0f - irradiance / 1000.0f, 0.0f, 1.0f)
    : estimateCloudCover(irradiance, measuredEpoch);

  char measuredAt[32], publishedAt[32], eventId[80], runCopy[33];
  uint32_t sequence;
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100))) {
    strncpy(runCopy, run_id, sizeof(runCopy));
    runCopy[sizeof(runCopy) - 1] = '\0';
    sequence = sample_id;
    xSemaphoreGive(dataMutex);
  } else {
    Serial.println("Telemetry skipped: data mutex timeout");
    return false;
  }
  formatLocalTimestamp(measuredEpoch, measuredAt, sizeof(measuredAt));
  formatUtcTimestamp(publishedEpoch, publishedAt, sizeof(publishedAt));
  snprintf(eventId, sizeof(eventId), "%s:%s:%lu", runCopy, household_id,
           static_cast<unsigned long>(sequence));

  char msg[1280];
  int length = snprintf(msg, sizeof(msg),
    "{\"schema_version\":1,\"event_id\":\"%s\",\"run_id\":\"%s\","
    "\"household_id\":\"%s\",\"timestamp\":\"%s\",\"published_at\":\"%s\","
    "\"interval_seconds\":%lu,\"irradiance_w_m2\":%.2f,\"temperature_c\":%.2f,"
    "\"cloud_cover\":%.4f,\"solar_power_kw\":%.6f,\"load_power_kw\":%.6f,"
    "\"net_power_kw\":%.6f,\"solar_energy_kwh\":%.6f,\"load_energy_kwh\":%.6f,"
    "\"surplus_energy_kwh\":%.6f,\"deficit_energy_kwh\":%.6f,"
    "\"data_mode\":\"%s\",\"demo_scenario\":\"%s\","
    "\"solar_voltage_v\":%.3f,\"solar_current_a\":%.4f,"
    "\"load_voltage_v\":%.3f,\"load_current_a\":%.4f}",
    eventId, runCopy, household_id, measuredAt, publishedAt,
    static_cast<unsigned long>(telemetry_interval_seconds), irradiance, temperature,
    cloudCover, solarPowerKw, loadPowerKw, netPowerKw, solarEnergyKwh, loadEnergyKwh,
    surplusEnergyKwh, deficitEnergyKwh, simulated ? "simulation" : "real",
    simulated ? demoScenarioName(scenario) : "none", solarVoltageV, solarCurrentMa / 1000.0f,
    loadVoltageV, loadCurrentMa / 1000.0f);

  if (length <= 0 || length >= static_cast<int>(sizeof(msg))) {
    Serial.println("Telemetry JSON buffer too small");
    return false;
  }
  if (!client.connected()) {
    Serial.println("Telemetry skipped: MQTT disconnected");
    return false;
  }
  if (!client.publish(telemetry_topic, msg, false)) {
    Serial.println("Telemetry publish failed");
    return false;
  }
  if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100))) {
    if (sample_id == sequence && strcmp(run_id, runCopy) == 0) sample_id++;
    xSemaphoreGive(dataMutex);
  }
  Serial.printf("Telemetry #%lu published mode=%s scenario=%s (%lu samples): %s\n",
                static_cast<unsigned long>(sequence), simulated ? "simulation" : "real",
                simulated ? demoScenarioName(scenario) : "none",
                static_cast<unsigned long>(powerSamples), msg);
  return true;
}

// ================= TASK 3: MQTT TELEMETRY CHO BACKEND/BLOCKCHAIN =================
void TaskMQTT(void *pvParameters) {
  unsigned long lastReconnectAttempt = 0;
  unsigned long lastNtpRetry = 0;
  bool timeReadyLogged = false;

  for (;;) {
    if (WiFi.status() == WL_CONNECTED) {
      if (!client.connected() && millis() - lastReconnectAttempt >= 3000) {
        lastReconnectAttempt = millis();
        char clientId[32];
        uint64_t chipId = ESP.getEfuseMac();
        snprintf(clientId, sizeof(clientId), "solar-iot-%04x%08x",
                 static_cast<uint16_t>(chipId >> 32), static_cast<uint32_t>(chipId));
        if (client.connect(clientId, mqtt_username, mqtt_password)) {
          Serial.printf("MQTT connected: %s:%d topic=%s\n", mqtt_server, mqtt_port, telemetry_topic);
          if (!client.subscribe(control_topic, 1)) {
            Serial.println("MQTT control subscribe failed");
          } else {
            Serial.printf("MQTT control topic: %s\n", control_topic);
          }
          if (!client.subscribe(actuator_topic, 1))
            Serial.println("MQTT actuator subscribe failed");
          else
            Serial.printf("MQTT actuator topic: %s\n", actuator_topic);
        } else {
          Serial.printf("MQTT connect failed, state=%d\n", client.state());
        }
      }
      if (client.connected()) client.loop();
    }

    time_t now = time(nullptr);
    if (now <= 1700000000 && millis() - lastNtpRetry >= 30000) {
      lastNtpRetry = millis();
      configTime(gmtOffset_sec, daylightOffset_sec,
                 ntpServer, ntpServerBackup1, ntpServerBackup2);
      Serial.println("NTP retry: pool.ntp.org, Google, Cloudflare");
    }
    if (now > 1700000000) {
      if (!timeReadyLogged) {
        char synchronizedAt[32];
        formatLocalTimestamp(now, synchronizedAt, sizeof(synchronizedAt));
        Serial.printf("NTP ready: %s\n", synchronizedAt);
        timeReadyLogged = true;
      }
      time_t currentInterval = (now / telemetry_interval_seconds) * telemetry_interval_seconds;
      if (demo_mode) {
        if (last_demo_publish_ms == 0 || millis() - last_demo_publish_ms >= demo_publish_period_ms) {
          last_demo_publish_ms = millis();
          float solarW = 0.0f, loadW = 0.0f, temperature = 0.0f;
          float solarV = 0.0f, solarMa = 0.0f, loadV = 0.0f, loadMa = 0.0f;
          DemoScenario scenario = DEMO_HOLD;
          if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100))) {
            if (demo_timestamp == 0) demo_timestamp = currentInterval;
            solarW = p_solar; loadW = p_load; temperature = temp_panel;
            solarV = v_solar; solarMa = i_solar; loadV = v_load; loadMa = i_load;
            scenario = scenarioForSample(sample_id);
            active_demo_scenario = scenario;
            xSemaphoreGive(dataMutex);
          }
          if (publishTelemetryRecord(demo_timestamp, now, solarW, loadW, temperature,
                                     solarV, solarMa, loadV, loadMa, true, scenario, 1)) {
            demo_timestamp += telemetry_interval_seconds;
          }
        }
        vTaskDelay(pdMS_TO_TICKS(50));
        continue;
      }
      time_t completedInterval = 0;
      double solarSum = 0.0, loadSum = 0.0, temperatureSum = 0.0;
      uint32_t powerSamples = 0, temperatureSamples = 0;

      if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(50))) {
        if (!interval_ready) {
          active_interval_start = currentInterval;
          interval_ready = true;
        } else if (currentInterval > active_interval_start) {
          completedInterval = active_interval_start;
          solarSum = interval_solar_w_sum;
          loadSum = interval_load_w_sum;
          temperatureSum = interval_temperature_sum;
          powerSamples = interval_power_samples;
          temperatureSamples = interval_temperature_samples;

          active_interval_start = currentInterval;
          interval_solar_w_sum = 0.0;
          interval_load_w_sum = 0.0;
          interval_temperature_sum = 0.0;
          interval_power_samples = 0;
          interval_temperature_samples = 0;
        }
        xSemaphoreGive(dataMutex);
      }

      if (completedInterval != 0 && powerSamples > 0) {
        float solarPowerW = static_cast<float>(solarSum / powerSamples);
        float loadPowerW = static_cast<float>(loadSum / powerSamples);
        float temperature = temperatureSamples > 0
          ? static_cast<float>(temperatureSum / temperatureSamples)
          : 0.0f;
        float solarV, solarMa, loadV, loadMa;
        if (xSemaphoreTake(dataMutex, pdMS_TO_TICKS(100))) {
          solarV = v_solar; solarMa = i_solar; loadV = v_load; loadMa = i_load;
          xSemaphoreGive(dataMutex);
        } else {
          solarV = solarMa = loadV = loadMa = 0.0f;
        }
        publishTelemetryRecord(completedInterval, now, solarPowerW, loadPowerW, temperature,
                               solarV, solarMa, loadV, loadMa, false, DEMO_AUTO, powerSamples);
      }
    }

    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

// ================= SETUP HỆ THỐNG CỐT LÕI =================
void setup() {
  Serial.begin(115200);
  Serial.setTimeout(50);
  delay(1000);
  Serial.println("\n--- KHOI DONG HE THONG P2P ENERGY ---");
  preferences.begin("p2p-solar", false);
  // Fresh boards use INA219 measurements. Existing saved demo mode still needs "demo off".
  demo_mode = preferences.getBool("demo_mode", false);
  uint8_t storedScenario = preferences.getUChar("demo_scenario", static_cast<uint8_t>(DEMO_AUTO));
  demo_scenario = storedScenario <= static_cast<uint8_t>(DEMO_HOLD)
    ? static_cast<DemoScenario>(storedScenario) : DEMO_AUTO;
  
  Wire.begin(); 

  lcd_available = i2cDevicePresent(0x27);
  if (lcd_available) {
    lcd.init();
    lcd.backlight();
  } else {
    Serial.println("LCD 0x27 not found; continuing without display");
  }
  solar_meter_available = ina219_phat.begin();
  load_meter_available = ina219_tieuthu.begin();
  ds18b20.begin();
  temperature_sensor_available = ds18b20.getDeviceCount() > 0;
  if (!solar_meter_available) Serial.println("INA219 solar 0x40 not found");
  if (!load_meter_available) Serial.println("INA219 load 0x41 not found");
  if (!temperature_sensor_available) Serial.println("DS18B20 not found");
  if (!solar_meter_available && !load_meter_available && !temperature_sensor_available) {
    demo_mode = true;
    preferences.putBool("demo_mode", true);
    Serial.println("Bare ESP32 detected: DEMO_MODE forced ON");
  }

  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY2_PIN, OUTPUT);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(RELAY1_PIN, HIGH); 
  digitalWrite(RELAY2_PIN, HIGH); 
  digitalWrite(LED_BUILTIN, LOW);

  WiFi.mode(WIFI_STA);
  for (size_t network = 0; network < wifi_network_count && WiFi.status() != WL_CONNECTED; network++) {
    if (lcd_available) {
      lcd.clear();
      lcd.setCursor(0, 0);
      lcd.print("Dang ket noi WiFi");
      lcd.setCursor(0, 1);
      lcd.print(wifi_ssids[network]);
    }

    WiFi.disconnect();
    delay(200);
    WiFi.begin(wifi_ssids[network], wifi_passwords[network]);
    Serial.printf("Dang ket noi WiFi: %s", wifi_ssids[network]);

    unsigned long wifiStartedAt = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - wifiStartedAt < 15000) {
      delay(500);
      Serial.print(".");
    }
    Serial.println();
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Loi: Khong ket noi duoc cac WiFi, khoi dong lai sau 5 giay...");
    if (lcd_available) {
      lcd.clear();
      lcd.setCursor(0, 0);
      lcd.print("WiFi that bai");
      lcd.setCursor(0, 1);
      lcd.print("Kiem tra 2.4G");
    }
    delay(5000);
    ESP.restart();
  }

  if (lcd_available) {
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("WiFi Connected!");
  }
  Serial.println("WiFi Connected!");
  Serial.print("ESP32 IP: ");
  Serial.println(WiFi.localIP());
  delay(1000);

  configTime(gmtOffset_sec, daylightOffset_sec,
             ntpServer, ntpServerBackup1, ntpServerBackup2);
  Serial.print("Dong bo NTP");
  unsigned long ntpStartedAt = millis();
  while (time(nullptr) <= 1700000000 && millis() - ntpStartedAt < 20000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (time(nullptr) <= 1700000000) {
    Serial.println("Canh bao: NTP chua san sang; firmware se cho dong bo truoc khi gui telemetry");
  }

  createRunId();
  Serial.printf("Telemetry run_id: %s\n", run_id);
  Serial.printf("DEMO_MODE=%s; scenario=%s; publish=%lus\n",
                demo_mode ? "ON" : "OFF", demoScenarioName(demo_scenario),
                static_cast<unsigned long>(demo_mode ? demo_publish_period_ms / 1000 : telemetry_interval_seconds));
  printDemoHelp();

  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttControlCallback);
  client.setBufferSize(1536);
  client.setKeepAlive(30);

  dataMutex = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(TaskSensor,  "Sensor",  4096, NULL, 2, NULL, 1);
  xTaskCreatePinnedToCore(TaskDisplay, "Display", 4096, NULL, 1, NULL, 1);
  xTaskCreatePinnedToCore(TaskMQTT,    "MQTT",    8192, NULL, 1, NULL, 0); 
}

void loop() {
  if (Serial.available()) {
    handleSerialCommand(Serial.readStringUntil('\n'));
  }
  updateActuator();
  delay(20);
}
