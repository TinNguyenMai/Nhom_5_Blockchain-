#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "mqtt_client.h"
#include "nvs_flash.h"
#include "cJSON.h"
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/schema/schema_generated.h"

#include "model_data.h"
#include "solar_features.h"
#include "lcd_display.h"
#include "power_meter.h"
#include "real_telemetry.h"
#include "temperature_sensor.h"

namespace {
constexpr char TAG[] = "solar_edge";
constexpr char TELEMETRY[] = "solar/home_01/telemetry";
constexpr char METER[] = "solar/home_01/meter";
constexpr char PREDICTION[] = "solar/home_01/prediction";
constexpr char CONTROL[] = "solar/home_01/control";
constexpr char ACTUATOR[] = "solar/home_01/actuator";
constexpr char ACTUATOR_STATUS[] = "solar/home_01/actuator/status";
constexpr int DEMO_REAL_PERIOD_MS = 5000;
constexpr int DEMO_SAMPLES_PER_SCENARIO = 12;
constexpr gpio_num_t RELAY1 = GPIO_NUM_4;
constexpr gpio_num_t RELAY2 = GPIO_NUM_25;
constexpr gpio_num_t STATUS_LED = GPIO_NUM_2;
constexpr size_t kArenaBytes = 32768;
constexpr uint32_t kWifiConnect = 1U << 0;
constexpr uint32_t kWifiReconnect = 1U << 1;
constexpr uint32_t kMqttStart = 1U << 2;
constexpr uint32_t kNetworkStackBytes = 8192;

enum DemoScenario { DEMO_AUTO, DEMO_SELL, DEMO_BUY, DEMO_HOLD };

alignas(16) uint8_t arena[kArenaBytes];
tflite::MicroInterpreter* interpreter;
TfLiteTensor* input;
TfLiteTensor* output;
QueueHandle_t samples;
TaskHandle_t network_worker;
esp_mqtt_client_handle_t mqtt;
uint32_t connection = 0;
volatile bool mqtt_ready = false;
// Default: real INA219 readings, one logical 5-minute sample per 5 wall-clock
// seconds ("real fast"). "real slow" keeps the trained 5-minute cadence;
// "demo on" replaces the sensors with generated samples.
volatile bool demo_enabled = false;
volatile bool fast_real = true;
volatile bool new_run_requested = true;
volatile DemoScenario demo_scenario = DEMO_AUTO;
char current_run[33]{};
portMUX_TYPE run_lock = portMUX_INITIALIZER_UNLOCKED;
int64_t actuator_deadline_us = 0;
int actuator_round = 0;
char actuator_action[8] = "off";

void snapshot_run(char (&run)[33]) {
    portENTER_CRITICAL(&run_lock);
    std::memcpy(run, current_run, sizeof(run));
    portEXIT_CRITICAL(&run_lock);
}

const char* scenario_name(DemoScenario scenario) {
    switch (scenario) {
        case DEMO_SELL: return "sell";
        case DEMO_BUY: return "buy";
        case DEMO_HOLD: return "hold";
        default: return "auto";
    }
}

float random_between(float low, float high) {
    return low + (high - low) * (static_cast<float>(esp_random()) / static_cast<float>(UINT32_MAX));
}

void set_idle_relays() {
    // GPIO4 supplies the local load. Keep it powered while measuring real
    // consumption; GPIO25 is the separate P2P path and stays disconnected.
    gpio_set_level(RELAY1, demo_enabled ? 1 : 0);
    gpio_set_level(RELAY2, 1);
    gpio_set_level(STATUS_LED, 0);
    actuator_deadline_us = 0;
    std::strcpy(actuator_action, "off");
}

void publish_actuator_status(const char* state) {
    char run[33];
    snapshot_run(run);
    if (!mqtt_ready || !run[0] || actuator_round < 1) return;
    cJSON* object = cJSON_CreateObject();
    cJSON_AddNumberToObject(object, "schema_version", 1);
    cJSON_AddStringToObject(object, "household_id", "home_01");
    cJSON_AddStringToObject(object, "run_id", run);
    cJSON_AddNumberToObject(object, "round_id", actuator_round);
    cJSON_AddStringToObject(object, "action", actuator_action);
    cJSON_AddBoolToObject(object, "relay1_on", gpio_get_level(RELAY1) == 0);
    cJSON_AddBoolToObject(object, "relay2_on", gpio_get_level(RELAY2) == 0);
    cJSON_AddStringToObject(object, "state", state);
    char* payload = cJSON_PrintUnformatted(object);
    if (payload) {
        esp_mqtt_client_enqueue(mqtt, ACTUATOR_STATUS, payload, 0, 1, 0, true);
        cJSON_free(payload);
    }
    cJSON_Delete(object);
}

void apply_actuator(const char* action, int round_id, int duration_seconds) {
    actuator_round = round_id;
    std::strncpy(actuator_action, action, sizeof(actuator_action) - 1);
    actuator_action[sizeof(actuator_action) - 1] = 0;
    if (!std::strcmp(action, "sell")) {
        gpio_set_level(RELAY1, 1);
        gpio_set_level(RELAY2, 0);
        gpio_set_level(STATUS_LED, 1);
    } else {
        gpio_set_level(RELAY1, 0);
        gpio_set_level(RELAY2, 0);
        gpio_set_level(STATUS_LED, 1);
    }
    actuator_deadline_us = esp_timer_get_time() + static_cast<int64_t>(duration_seconds) * 1000000;
    publish_actuator_status("applied");
    ESP_LOGI(TAG, "ACTUATOR round=%d action=%s relay1=%s relay2=ON duration=%ds",
             round_id, action, !std::strcmp(action, "buy") ? "ON" : "OFF", duration_seconds);
}

void handle_command(const char* command) {
    if (!std::strcmp(command, "demo on")) {
        demo_enabled = true;
        new_run_requested = true;
        set_idle_relays();
        ESP_LOGI(TAG, "DEMO_MODE=ON; local relay GPIO4=OFF P2P GPIO25=OFF until settlement");
    } else if (!std::strcmp(command, "demo off")) {
        demo_enabled = false;
        new_run_requested = true;
        set_idle_relays();
        solar::lcd_status("Reading INA219");
        ESP_LOGI(TAG, "DEMO_MODE=OFF; real INA219 measurement enabled; local relay GPIO4=ON P2P GPIO25=OFF");
    } else if (!std::strcmp(command, "real fast") || !std::strcmp(command, "real slow")) {
        fast_real = command[5] == 'f';
        new_run_requested = true;
        ESP_LOGI(TAG, "REAL sampling=%s; new AI history requested", fast_real ? "5s" : "5min");
    } else if (!std::strcmp(command, "demo status")) {
        char run[33];
        snapshot_run(run);
        ESP_LOGI(TAG, "DEMO_MODE=%s real_sampling=%s scenario=%s run_id=%s local_relay=%s p2p_relay=%s",
                 demo_enabled ? "ON" : "OFF", fast_real ? "5s" : "5min", scenario_name(demo_scenario), run,
                 gpio_get_level(RELAY1) == 0 ? "ON" : "OFF", gpio_get_level(RELAY2) == 0 ? "ON" : "OFF");
    } else if (!std::strncmp(command, "demo scenario ", 14)) {
        const char* value = command + 14;
        if (!std::strcmp(value, "auto")) demo_scenario = DEMO_AUTO;
        else if (!std::strcmp(value, "sell")) demo_scenario = DEMO_SELL;
        else if (!std::strcmp(value, "buy")) demo_scenario = DEMO_BUY;
        else if (!std::strcmp(value, "hold")) demo_scenario = DEMO_HOLD;
        else { ESP_LOGW(TAG, "Unknown demo scenario: %s", value); return; }
        new_run_requested = true;
        ESP_LOGI(TAG, "DEMO scenario=%s; new AI history requested", scenario_name(demo_scenario));
    }
}

void handle_actuator_command(const char* command) {
    // Real mode powers the local load, while keeping the P2P trade path off.
    if (!demo_enabled) {
        ESP_LOGW(TAG, "Actuator ignored in real measurement mode; local load ON P2P OFF");
        return;
    }
    char action[8]{};
    int round_id = 0, duration = 0;
    char extra = 0;
    if (std::sscanf(command, "settled:%7[^:]:%d:%d%c", action, &round_id, &duration, &extra) != 3 ||
        (std::strcmp(action, "sell") && std::strcmp(action, "buy")) ||
        round_id < 1 || duration < 1 || duration > 60) {
        ESP_LOGW(TAG, "Rejected invalid actuator command");
        return;
    }
    apply_actuator(action, round_id, duration);
}

const char* string_field(cJSON* object, const char* name) {
    const cJSON* item = cJSON_GetObjectItemCaseSensitive(object, name);
    return cJSON_IsString(item) ? item->valuestring : nullptr;
}

bool number_field(cJSON* object, const char* name, double low, double high, double& result) {
    const cJSON* item = cJSON_GetObjectItemCaseSensitive(object, name);
    if (!cJSON_IsNumber(item) || !std::isfinite(item->valuedouble) || item->valuedouble < low || item->valuedouble > high) return false;
    result = item->valuedouble;
    return true;
}

bool parse_sample(cJSON* object, solar::Sample& sample) {
    double number;
    const char* home = string_field(object, "household_id");
    const char* run = string_field(object, "run_id");
    const char* event = string_field(object, "event_id");
    if (!home || std::strcmp(home, "home_01") || !run || std::strlen(run) != 32 || !event || std::strlen(event) >= sizeof(sample.event)) return false;
    for (int i = 0; i < 32; ++i) if (!std::strchr("0123456789abcdef", run[i])) return false;
    char prefix[64];
    std::snprintf(prefix, sizeof(prefix), "%s:home_01:", run);
    size_t n = std::strlen(prefix);
    if (std::strncmp(event, prefix, n) || event[n] == '\0') return false;
    for (const char* c = event + n; *c; ++c) if (*c < '0' || *c > '9') return false;
    char* end;
    long long sequence = std::strtoll(event + n, &end, 10);
    if (*end || sequence < 0 || sequence >= INT_MAX) return false;
    if (!number_field(object, "schema_version", 1, 1, number) || !number_field(object, "interval_seconds", 300, 300, number)) return false;
    if (!solar::parse_time(string_field(object, "timestamp"), sample.local_seconds)) return false;
    const char* fields[] = {"solar_power_kw", "load_power_kw", "irradiance_w_m2", "cloud_cover"};
    const double upper[] = {100, 100, 1500, 1};
    for (int i = 0; i < 4; ++i) {
        if (!number_field(object, fields[i], 0, upper[i], number)) return false;
        sample.values[i] = static_cast<float>(number);
    }
    std::strcpy(sample.run, run);
    std::strcpy(sample.event, event);
    sample.sequence = static_cast<int32_t>(sequence);
    sample.connection = connection;
    const char* mode = string_field(object, "data_mode");
    sample.real_measurement = mode && !std::strcmp(mode, "real");
    const char* time_mode = string_field(object, "time_mode");
    sample.accelerated = time_mode && !std::strcmp(time_mode, "accelerated");
    return true;
}

void mqtt_event(void*, esp_event_base_t, int32_t id, void* data) {
    auto* event = static_cast<esp_mqtt_event_handle_t>(data);
    static char payload[2048];
    static char topic[96];
    static int received = 0, total = 0;
    static bool accepted = false;
    if (id == MQTT_EVENT_CONNECTED) {
        ++connection;
        mqtt_ready = true;
        if (demo_enabled) solar::lcd_status("Waiting data");
        esp_mqtt_client_subscribe(mqtt, TELEMETRY, 1);
        esp_mqtt_client_subscribe(mqtt, CONTROL, 1);
        esp_mqtt_client_subscribe(mqtt, ACTUATOR, 1);
        ESP_LOGI(TAG, "MQTT connected; demo telemetry + Edge AI + actuator ready");
    } else if (id == MQTT_EVENT_DISCONNECTED) {
        mqtt_ready = false;
        accepted = false;
        if (demo_enabled) solar::lcd_status("MQTT offline");
        ESP_LOGW(TAG, "MQTT disconnected; reconnecting");
    } else if (id == MQTT_EVENT_DATA) {
        if (event->current_data_offset == 0) {
            total = event->total_data_len;
            received = 0;
            accepted = !event->retain && total > 0 && total < static_cast<int>(sizeof(payload)) &&
                       event->topic_len > 0 && event->topic_len < static_cast<int>(sizeof(topic));
            if (accepted) {
                std::memcpy(topic, event->topic, event->topic_len);
                topic[event->topic_len] = 0;
            }
        }
        if (!accepted || event->total_data_len != total || event->current_data_offset != received ||
            event->data_len < 0 || received + event->data_len > total) { accepted = false; return; }
        std::memcpy(payload + received, event->data, event->data_len);
        received += event->data_len;
        if (received == total) {
            payload[total] = 0;
            if (!std::strcmp(topic, CONTROL)) handle_command(payload);
            else if (!std::strcmp(topic, ACTUATOR)) handle_actuator_command(payload);
            else if (!std::strcmp(topic, TELEMETRY)) {
                cJSON* object = cJSON_ParseWithOpts(payload, nullptr, true);
                const char* run = object ? string_field(object, "run_id") : nullptr;
                char own_run[33];
                snapshot_run(own_run);
                // Our producer already queues its samples. Never process the MQTT
                // echo twice, or replace physical measurements with external data.
                if (demo_enabled && !(run && !std::strcmp(run, own_run))) {
                    solar::Sample sample;
                    if (object && parse_sample(object, sample)) {
                        solar::lcd_telemetry(sample.values[0], sample.values[1]);
                        if (xQueueSend(samples, &sample, 0) != pdTRUE) ESP_LOGW(TAG, "Inference queue full");
                    } else ESP_LOGW(TAG, "Rejected invalid telemetry");
                }
                cJSON_Delete(object);
            }
            accepted = false;
        }
    } else if (id == MQTT_EVENT_ERROR) {
        if (event->error_handle && event->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
            ESP_LOGE(TAG, "MQTT broker refused connection (code=%d): check CONFIG_SOLAR_MQTT_USERNAME/PASSWORD",
                     static_cast<int>(event->error_handle->connect_return_code));
        } else {
            ESP_LOGE(TAG, "MQTT transport error: check %s and Windows firewall", CONFIG_SOLAR_MQTT_URI);
        }
    }
}

void connect_wifi() {
    if (!CONFIG_SOLAR_WIFI_SSID[0]) {
        ESP_LOGE(TAG, "Set CONFIG_SOLAR_WIFI_SSID/PASSWORD before building firmware");
        return;
    }
    wifi_config_t wifi{};
    std::strncpy(reinterpret_cast<char*>(wifi.sta.ssid), CONFIG_SOLAR_WIFI_SSID, sizeof(wifi.sta.ssid) - 1);
    std::strncpy(reinterpret_cast<char*>(wifi.sta.password), CONFIG_SOLAR_WIFI_PASSWORD, sizeof(wifi.sta.password) - 1);
    wifi.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    // Phone hotspots may advertise WPA3-SAE; accept both password-element methods.
    wifi.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi));
    ESP_LOGI(TAG, "Connecting Wi-Fi: %s", CONFIG_SOLAR_WIFI_SSID);
    ESP_ERROR_CHECK(esp_wifi_connect());
}

void start_mqtt() {
    if (mqtt) return;
    esp_mqtt_client_config_t cfg{};
    cfg.broker.address.uri = CONFIG_SOLAR_MQTT_URI;
    cfg.credentials.username = CONFIG_SOLAR_MQTT_USERNAME;
    cfg.credentials.authentication.password = CONFIG_SOLAR_MQTT_PASSWORD;
    cfg.session.keepalive = 20;
    cfg.network.reconnect_timeout_ms = 2000;
    cfg.buffer.size = 2048;
    cfg.outbox.limit = 8192;
    mqtt = esp_mqtt_client_init(&cfg);
    ESP_ERROR_CHECK(mqtt ? ESP_OK : ESP_FAIL);
    ESP_ERROR_CHECK(esp_mqtt_client_register_event(mqtt, MQTT_EVENT_ANY, mqtt_event, nullptr));
    ESP_ERROR_CHECK(esp_mqtt_client_start(mqtt));
}

void network_task(void*) {
    ESP_LOGI(TAG, "Network worker ready; stack=%u bytes", static_cast<unsigned>(kNetworkStackBytes));
    bool clock_started = false;
    while (true) {
        uint32_t requests = 0;
        if (xTaskNotifyWait(0, UINT32_MAX, &requests, portMAX_DELAY) != pdTRUE) continue;
        if (requests & (kWifiConnect | kWifiReconnect)) {
            if (requests & kWifiReconnect) vTaskDelay(pdMS_TO_TICKS(1000));
            connect_wifi();
        }
        if (requests & kMqttStart) {
            if (!clock_started) {
                esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
                esp_err_t error = esp_netif_sntp_init(&config);
                clock_started = error == ESP_OK;
                if (!clock_started) ESP_LOGW(TAG, "SNTP start failed: %s", esp_err_to_name(error));
            }
            start_mqtt();
        }
    }
}

void wifi_event(void*, esp_event_base_t base, int32_t id, void*) {
    // This callback runs on sys_evt's small stack. Keep connecting, delays and
    // MQTT initialization on our network worker so system events keep flowing.
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        xTaskNotify(network_worker, kWifiConnect, eSetBits);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        mqtt_ready = false;
        xTaskNotify(network_worker, kWifiReconnect, eSetBits);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ESP_LOGI(TAG, "Wi-Fi ready");
        xTaskNotify(network_worker, kMqttStart, eSetBits);
    }
}

bool setup_model() {
    const tflite::Model* model = tflite::GetModel(kModel);
    if (model->version() != TFLITE_SCHEMA_VERSION) return false;
    static tflite::MicroMutableOpResolver<1> resolver;
    if (resolver.AddFullyConnected() != kTfLiteOk) return false;
    static tflite::MicroInterpreter engine(model, resolver, arena, sizeof(arena));
    interpreter = &engine;
    if (engine.AllocateTensors() != kTfLiteOk) return false;
    input = engine.input(0);
    output = engine.output(0);
    if (input->type != kTfLiteInt8 || output->type != kTfLiteInt8 || input->bytes != solar::kFeatures ||
        output->bytes != 2 || input->params.scale <= 0 || output->params.scale <= 0) return false;
    std::memcpy(input->data.int8, kSelfTestInput, sizeof(kSelfTestInput));
    if (engine.Invoke() != kTfLiteOk) return false;
    for (int i = 0; i < 2; ++i)
        if (std::abs(static_cast<int>(output->data.int8[i]) - kSelfTestExpected[i]) > 1) return false;
    ESP_LOGI(TAG, "SELFTEST PASS model=%s bytes=%u arena_used=%u", kModelVersion,
             static_cast<unsigned>(sizeof(kModel)), static_cast<unsigned>(engine.arena_used_bytes()));
    return true;
}

void inference_task(void*) {
    solar::History history;
    solar::Sample sample;
    while (true) {
        if (xQueueReceive(samples, &sample, portMAX_DELAY) != pdTRUE) continue;
        if (!history.add(sample)) {
            ESP_LOGI(TAG, "AI warmup/history %d/%d", history.count, solar::kWindow);
            continue;
        }
        float vector[solar::kFeatures];
        solar::features(history.rows, vector);
        int clipped = 0;
        for (int i = 0; i < solar::kFeatures; ++i) {
            float raw = vector[i] / input->params.scale + input->params.zero_point;
            if (raw < -128.5f || raw > 127.5f) ++clipped;
            input->data.int8[i] = solar::quantize(vector[i], input->params.scale, input->params.zero_point);
        }
        int64_t begin = esp_timer_get_time();
        if (interpreter->Invoke() != kTfLiteOk) { ESP_LOGE(TAG, "Invoke failed"); continue; }
        int64_t elapsed = esp_timer_get_time() - begin;
        float predicted[2];
        for (int i = 0; i < 2; ++i) {
            float delta = (static_cast<int>(output->data.int8[i]) - output->params.zero_point) * output->params.scale;
            predicted[i] = std::max(0.f, sample.values[i] + delta * kOutputScale[i]);
        }
        char input_time[32], target_time[32], device_id[32];
        solar::format_time(sample.local_seconds, input_time, sizeof(input_time));
        solar::format_time(sample.local_seconds + solar::kStep, target_time, sizeof(target_time));
        uint8_t mac[6];
        esp_wifi_get_mac(WIFI_IF_STA, mac);
        std::snprintf(device_id, sizeof(device_id), "esp32-%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
        cJSON* result = cJSON_CreateObject();
        cJSON_AddNumberToObject(result, "schema_version", 1);
        cJSON_AddStringToObject(result, "household_id", "home_01");
        cJSON_AddStringToObject(result, "run_id", sample.run);
        cJSON_AddStringToObject(result, "input_event_id", sample.event);
        cJSON_AddStringToObject(result, "input_timestamp", input_time);
        cJSON_AddStringToObject(result, "target_timestamp", target_time);
        cJSON_AddNumberToObject(result, "interval_seconds", solar::kStep);
        cJSON_AddStringToObject(result, "model_version", kModelVersion);
        cJSON_AddStringToObject(result, "device_kind", "esp32");
        cJSON_AddStringToObject(result, "device_id", device_id);
        cJSON_AddStringToObject(result, "data_mode", sample.real_measurement ? "real" : "simulation");
        cJSON_AddNumberToObject(result, "history_samples", history.count);
        cJSON_AddStringToObject(result, "time_mode", sample.accelerated ? "accelerated" : "realtime");
        cJSON_AddNumberToObject(result, "sampling_seconds", sample.accelerated ? DEMO_REAL_PERIOD_MS / 1000 : solar::kStep);
        cJSON_AddNumberToObject(result, "predicted_solar_kw", predicted[0]);
        cJSON_AddNumberToObject(result, "predicted_load_kw", predicted[1]);
        cJSON_AddNumberToObject(result, "predicted_net_kw", predicted[0] - predicted[1]);
        cJSON_AddNumberToObject(result, "predicted_surplus_kwh", std::max(0.f, predicted[0] - predicted[1]) / 12.f);
        cJSON_AddNumberToObject(result, "inference_us", static_cast<double>(elapsed));
        cJSON_AddNumberToObject(result, "arena_used_bytes", interpreter->arena_used_bytes());
        cJSON_AddNumberToObject(result, "free_heap_bytes", esp_get_free_heap_size());
        cJSON_AddNumberToObject(result, "clipped_features", clipped);
        cJSON_AddNumberToObject(result, "model_bytes", sizeof(kModel));
        char* payload = cJSON_PrintUnformatted(result);
        if (payload && mqtt_ready) {
            int queued = esp_mqtt_client_enqueue(mqtt, PREDICTION, payload, 0, 1, 0, true);
            ESP_LOGI(TAG, "AI PRED target=%s solar=%.3f load=%.3f net=%+.3f inference=%lldus queued=%d",
                     target_time, predicted[0], predicted[1], predicted[0] - predicted[1],
                     static_cast<long long>(elapsed), queued);
        }
        if (payload) cJSON_free(payload);
        cJSON_Delete(result);
    }
}

void make_run_id() {
    uint8_t bytes[16];
    char run[33];
    esp_fill_random(bytes, sizeof(bytes));
    for (int i = 0; i < 16; ++i) std::snprintf(run + i * 2, 3, "%02x", bytes[i]);
    run[32] = 0;
    portENTER_CRITICAL(&run_lock);
    std::memcpy(current_run, run, sizeof(run));
    portEXIT_CRITICAL(&run_lock);
}

DemoScenario active_scenario(uint32_t sequence) {
    if (demo_scenario != DEMO_AUTO) return demo_scenario;
    switch ((sequence / DEMO_SAMPLES_PER_SCENARIO) % 3) {
        case 0: return DEMO_SELL;
        case 1: return DEMO_BUY;
        default: return DEMO_HOLD;
    }
}

void publish_demo_sample(uint32_t sequence, int64_t start_seconds) {
    DemoScenario scenario = active_scenario(sequence);
    float solar_kw, load_kw, irradiance, cloud;
    if (scenario == DEMO_SELL) {
        solar_kw = random_between(2.4f, 3.9f);
        load_kw = random_between(0.35f, 0.95f);
        irradiance = random_between(720.f, 1000.f);
        cloud = random_between(0.02f, 0.25f);
    } else if (scenario == DEMO_BUY) {
        solar_kw = random_between(0.f, 0.35f);
        load_kw = random_between(1.8f, 3.6f);
        irradiance = random_between(0.f, 160.f);
        cloud = random_between(0.72f, 1.f);
    } else {
        float base = random_between(0.65f, 1.45f);
        solar_kw = base;
        load_kw = std::max(0.05f, base + random_between(-0.05f, 0.05f));
        irradiance = random_between(280.f, 520.f);
        cloud = random_between(0.3f, 0.65f);
    }
    float net = solar_kw - load_kw;
    float solar_kwh = solar_kw / 12.f;
    float load_kwh = load_kw / 12.f;
    float solar_v = random_between(18.f, 22.f);
    float load_v = random_between(218.f, 242.f);
    int64_t timestamp = start_seconds + static_cast<int64_t>(sequence) * solar::kStep;
    char time_text[32], event_id[96];
    solar::format_time(timestamp, time_text, sizeof(time_text));
    std::snprintf(event_id, sizeof(event_id), "%s:home_01:%lu", current_run, static_cast<unsigned long>(sequence));
    cJSON* object = cJSON_CreateObject();
    cJSON_AddNumberToObject(object, "schema_version", 1);
    cJSON_AddStringToObject(object, "event_id", event_id);
    cJSON_AddStringToObject(object, "run_id", current_run);
    cJSON_AddStringToObject(object, "household_id", "home_01");
    cJSON_AddStringToObject(object, "timestamp", time_text);
    cJSON_AddStringToObject(object, "published_at", time_text);
    cJSON_AddNumberToObject(object, "interval_seconds", solar::kStep);
    cJSON_AddNumberToObject(object, "irradiance_w_m2", irradiance);
    cJSON_AddNumberToObject(object, "temperature_c", random_between(25.f, 46.f));
    cJSON_AddStringToObject(object, "temperature_source", "simulation");
    cJSON_AddBoolToObject(object, "temperature_valid", true);
    cJSON_AddNumberToObject(object, "cloud_cover", cloud);
    cJSON_AddNumberToObject(object, "solar_power_kw", solar_kw);
    cJSON_AddNumberToObject(object, "load_power_kw", load_kw);
    cJSON_AddNumberToObject(object, "net_power_kw", net);
    cJSON_AddNumberToObject(object, "solar_energy_kwh", solar_kwh);
    cJSON_AddNumberToObject(object, "load_energy_kwh", load_kwh);
    cJSON_AddNumberToObject(object, "surplus_energy_kwh", std::max(0.f, solar_kwh - load_kwh));
    cJSON_AddNumberToObject(object, "deficit_energy_kwh", std::max(0.f, load_kwh - solar_kwh));
    cJSON_AddStringToObject(object, "data_mode", "simulation");
    cJSON_AddStringToObject(object, "time_mode", "accelerated");
    cJSON_AddNumberToObject(object, "sampling_seconds", DEMO_REAL_PERIOD_MS / 1000);
    cJSON_AddStringToObject(object, "demo_scenario", scenario_name(scenario));
    cJSON_AddNumberToObject(object, "solar_voltage_v", solar_v);
    cJSON_AddNumberToObject(object, "solar_current_a", solar_kw * 1000.f / solar_v);
    cJSON_AddNumberToObject(object, "load_voltage_v", load_v);
    cJSON_AddNumberToObject(object, "load_current_a", load_kw * 1000.f / load_v);
    char* payload = cJSON_PrintUnformatted(object);
    if (payload) {
        int queued = esp_mqtt_client_enqueue(mqtt, TELEMETRY, payload, 0, 1, 0, true);
        solar::Sample sample;
        if (queued >= 0 && parse_sample(object, sample)) {
            xQueueSend(samples, &sample, 0);
            solar::lcd_telemetry(sample.values[0], sample.values[1]);
        }
        ESP_LOGI(TAG, "DEMO sample=%lu scenario=%s solar=%.3f load=%.3f AI_history=%d/%d queued=%d",
                 static_cast<unsigned long>(sequence), scenario_name(scenario), solar_kw, load_kw,
                 std::min<int>(sequence + 1, solar::kWindow), solar::kWindow, queued);
        cJSON_free(payload);
    }
    cJSON_Delete(object);
}

int enqueue_record(const char* topic, cJSON* object) {
    if (!object) return -1;
    char* payload = cJSON_PrintUnformatted(object);
    int queued = -1;
    if (payload && mqtt_ready) queued = esp_mqtt_client_enqueue(mqtt, topic, payload, 0, 1, 0, true);
    if (payload) cJSON_free(payload);
    return queued;
}

void telemetry_task(void*) {
    solar::PowerMeters meters;
    solar::PowerInterval interval;
    solar::PowerWindow window;
    int64_t demo_start = 0;
    solar::parse_time("2026-10-02T06:00:00+07:00", demo_start);
    uint32_t sequence = 0, fast_step = 0;
    bool previous_demo = demo_enabled;
    int64_t next_demo = 0, next_live = 0, next_fast = 0, fast_start_utc = 0;
    TickType_t last = xTaskGetTickCount();
    while (true) {
        const bool is_demo = demo_enabled;
        const int64_t now = esp_timer_get_time();
        if (new_run_requested || previous_demo != is_demo) {
            new_run_requested = false;
            make_run_id();
            sequence = fast_step = 0;
            interval.reset();
            window.reset();
            next_demo = next_live = next_fast = 0;
            previous_demo = is_demo;
            ESP_LOGI(TAG, "SOURCE=%s run_id=%s; new AI history",
                     is_demo ? "simulation" : fast_real ? "ina219/5s" : "ina219/5min", current_run);
        }
        if (is_demo) {
            if (mqtt_ready && now >= next_demo) {
                if (!next_demo) next_demo = now;
                publish_demo_sample(sequence++, demo_start);
                const int64_t period = static_cast<int64_t>(DEMO_REAL_PERIOD_MS) * 1000;
                next_demo += period;
                if (next_demo <= now) next_demo = now + period;
            }
        } else {
            solar::PowerReadings reading = meters.read();
            reading.temperature = solar::temperature_snapshot();
            const int page = (now / 3000000) % 3;
            if (page == 2) solar::lcd_temperature(reading.temperature);
            else solar::lcd_measurements(reading, page == 1);
            const int64_t utc = static_cast<int64_t>(std::time(nullptr));
            const bool synced = utc > 1700000000;
            if (now >= next_live) {
                if (!next_live) next_live = now;
                cJSON* object = solar::live_meter_record(current_run, reading, synced ? utc : 0);
                const int queued = enqueue_record(METER, object);
                cJSON_Delete(object);
                ESP_LOGI(TAG, "REAL solar_valid=%d V=%.2f A=%.4f W=%.3f load_valid=%d V=%.2f A=%.4f W=%.3f time_synced=%d queued=%d",
                         reading.solar.valid, reading.solar.voltage_v, reading.solar.current_a, reading.solar.power_w,
                         reading.load.valid, reading.load.voltage_v, reading.load.current_a, reading.load.power_w, synced, queued);
                if (!synced && !fast_real) ESP_LOGW(TAG, "Waiting for SNTP: LCD/live readings continue; 5-minute telemetry waits for clock");
                ESP_LOGI(TAG, "REAL temperature_valid=%d temperature=%.2fC source=%s", reading.temperature.valid,
                         reading.temperature.celsius, reading.temperature.valid ? "ds18b20" : "unavailable");
                next_live += 5000000;
                if (next_live <= now) next_live = now + 5000000;
            }
            solar::CompletedPowerInterval complete;
            if (fast_real) {
                // Each 5-second average of real readings becomes one logical 5-minute
                // model step. A discarded window leaves a gap, which restarts AI history.
                const int64_t period = static_cast<int64_t>(DEMO_REAL_PERIOD_MS) * 1000;
                if (!mqtt_ready) { window.reset(); next_fast = 0; }
                else if (!next_fast) {
                    window.reset();
                    next_fast = now + period;
                    if (!fast_start_utc || !sequence)
                        fast_start_utc = synced ? utc / solar::kStep * solar::kStep : demo_start - 7 * 3600;
                } else {
                    window.add(reading);
                    if (now >= next_fast) {
                        next_fast += period;
                        if (next_fast <= now) next_fast = now + period;
                        complete.start_utc = fast_start_utc + static_cast<int64_t>(fast_step++) * solar::kStep;
                        if (!window.finish(complete)) ESP_LOGW(TAG, "REAL 5s window discarded: fewer than %u valid INA219 reads",
                                                               static_cast<unsigned>(solar::kMinWindowSamples));
                        else {
                            cJSON* object = solar::real_telemetry_record(current_run, sequence++, complete,
                                                                         synced ? utc : complete.start_utc, DEMO_REAL_PERIOD_MS / 1000);
                            const int queued = enqueue_record(TELEMETRY, object);
                            solar::Sample sample;
                            if (queued >= 0 && object && parse_sample(object, sample) && xQueueSend(samples, &sample, 0) != pdTRUE)
                                ESP_LOGW(TAG, "Inference queue full");
                            ESP_LOGI(TAG, "REAL 5s sample=%lu reads=%lu solar=%.3fW load=%.3fW queued=%d",
                                     static_cast<unsigned long>(sequence - 1), static_cast<unsigned long>(complete.samples),
                                     complete.average.solar.power_w, complete.average.load.power_w, queued);
                            cJSON_Delete(object);
                        }
                    }
                }
            } else if (!synced) interval.reset();
            else if (interval.add(utc, now, reading, complete)) {
                cJSON* object = solar::real_telemetry_record(current_run, sequence++, complete, utc);
                const int queued = enqueue_record(TELEMETRY, object);
                solar::Sample sample;
                if (queued >= 0 && object && parse_sample(object, sample) && xQueueSend(samples, &sample, 0) != pdTRUE)
                    ESP_LOGW(TAG, "Inference queue full");
                ESP_LOGI(TAG, "REAL interval=%lld samples=%lu solar=%.3fW load=%.3fW queued=%d",
                         static_cast<long long>(complete.start_utc), static_cast<unsigned long>(complete.samples),
                         complete.average.solar.power_w, complete.average.load.power_w, queued);
                cJSON_Delete(object);
            }
        }
        vTaskDelayUntil(&last, pdMS_TO_TICKS(500));
    }
}

void actuator_task(void*) {
    bool led = true;
    while (true) {
        if (actuator_deadline_us && esp_timer_get_time() >= actuator_deadline_us) {
            int finished_round = actuator_round;
            set_idle_relays();
            actuator_round = finished_round;
            publish_actuator_status("timeout");
            ESP_LOGI(TAG, "ACTUATOR round=%d timeout; local relay=%s P2P=OFF", finished_round, demo_enabled ? "OFF" : "ON");
        } else if (actuator_deadline_us && !std::strcmp(actuator_action, "buy")) {
            led = !led;
            gpio_set_level(STATUS_LED, led);
        }
        vTaskDelay(pdMS_TO_TICKS(250));
    }
}
}  // namespace

extern "C" void app_main() {
    gpio_config_t output{};
    output.pin_bit_mask = (1ULL << RELAY1) | (1ULL << RELAY2) | (1ULL << STATUS_LED);
    output.mode = GPIO_MODE_INPUT_OUTPUT;
    output.pull_up_en = GPIO_PULLUP_DISABLE;
    output.pull_down_en = GPIO_PULLDOWN_DISABLE;
    output.intr_type = GPIO_INTR_DISABLE;
    ESP_ERROR_CHECK(gpio_config(&output));
    set_idle_relays();
    if (!setup_model()) { ESP_LOGE(TAG, "Model setup/self-test failed; stopping"); return; }
    esp_err_t bus_error = solar::i2c_start();
    if (bus_error != ESP_OK) ESP_LOGW(TAG, "I2C unavailable: %s; continuing", esp_err_to_name(bus_error));
    solar::lcd_start();
    solar::temperature_start();
    esp_err_t rc = nvs_flash_init();
    if (rc == ESP_ERR_NVS_NO_FREE_PAGES || rc == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        rc = nvs_flash_init();
    }
    ESP_ERROR_CHECK(rc);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t wifi_init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wifi_init));
    ESP_ERROR_CHECK(xTaskCreate(network_task, "solar_network", kNetworkStackBytes, nullptr, 4, &network_worker) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, nullptr));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    samples = xQueueCreate(32, sizeof(solar::Sample));
    ESP_ERROR_CHECK(samples ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(xTaskCreate(inference_task, "solar_infer", 8192, nullptr, 5, nullptr) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(xTaskCreate(telemetry_task, "solar_data", 8192, nullptr, 4, nullptr) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(xTaskCreate(actuator_task, "solar_actuator", 3072, nullptr, 3, nullptr) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_LOGI(TAG, "Commands via MQTT %s: demo on|off|status|scenario auto|sell|buy|hold, real fast|slow", CONTROL);
}
