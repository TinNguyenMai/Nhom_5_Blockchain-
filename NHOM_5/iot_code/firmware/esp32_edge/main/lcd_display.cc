#include "lcd_display.h"
#include "i2c_bus.h"

#include <cstdio>
#include <cstring>

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

namespace solar {
namespace {
constexpr char kTag[] = "solar_lcd";
constexpr uint16_t kAddress = 0x27;
constexpr gpio_num_t kSda = GPIO_NUM_21;
constexpr gpio_num_t kScl = GPIO_NUM_22;
constexpr uint8_t kBacklight = 0x08;
constexpr uint8_t kEnable = 0x04;
constexpr uint8_t kData = 0x01;
constexpr size_t kColumns = 16;

struct Frame {
    char lines[2][kColumns + 1]{};
};

QueueHandle_t mailbox = nullptr;

class Display {
public:
    ~Display() {
        if (device_) i2c_master_bus_rm_device(device_);
    }

    esp_err_t init() {
        bus_ = i2c_bus();
        if (!bus_) return ESP_ERR_INVALID_STATE;
        esp_err_t error = i2c_master_probe(bus_, kAddress, 20);
        if (error != ESP_OK) return error;
        i2c_device_config_t device_config{};
        device_config.dev_addr_length = I2C_ADDR_BIT_LEN_7;
        device_config.device_address = kAddress;
        device_config.scl_speed_hz = 100000;
        error = i2c_master_bus_add_device(bus_, &device_config, &device_);
        if (error != ESP_OK) return error;

        // Reset HD44780 even when only the ESP32 was reset and the LCD stayed on.
        vTaskDelay(pdMS_TO_TICKS(50));
        if ((error = nibble(0x30)) != ESP_OK) return error;
        vTaskDelay(pdMS_TO_TICKS(5));
        if ((error = nibble(0x30)) != ESP_OK) return error;
        vTaskDelay(pdMS_TO_TICKS(5));
        if ((error = nibble(0x30)) != ESP_OK) return error;
        esp_rom_delay_us(200);
        if ((error = nibble(0x20)) != ESP_OK) return error;
        if ((error = send(0x28, false)) != ESP_OK) return error;  // 4-bit, 2 rows
        if ((error = send(0x08, false)) != ESP_OK) return error;  // display off
        if ((error = send(0x01, false)) != ESP_OK) return error;  // clear
        vTaskDelay(pdMS_TO_TICKS(3));
        if ((error = send(0x06, false)) != ESP_OK) return error;  // advance cursor
        return send(0x0c, false);                               // display on
    }

    esp_err_t render(const Frame& frame) {
        for (int row = 0; row < 2; ++row) {
            esp_err_t error = send(row ? 0xc0 : 0x80, false);
            if (error != ESP_OK) return error;
            size_t length = std::strlen(frame.lines[row]);
            for (size_t column = 0; column < kColumns; ++column) {
                uint8_t character = column < length ? frame.lines[row][column] : ' ';
                error = send(character, true);
                if (error != ESP_OK) return error;
            }
        }
        return ESP_OK;
    }

private:
    esp_err_t nibble(uint8_t value) {
        uint8_t pins = value | kBacklight;
        const uint8_t bytes[] = {pins, static_cast<uint8_t>(pins | kEnable), pins};
        esp_err_t error = i2c_master_transmit(device_, bytes, sizeof(bytes), 20);
        esp_rom_delay_us(50);
        return error;
    }

    esp_err_t send(uint8_t value, bool data) {
        uint8_t mode = kBacklight | (data ? kData : 0);
        uint8_t high = (value & 0xf0) | mode;
        uint8_t low = ((value << 4) & 0xf0) | mode;
        const uint8_t bytes[] = {
            high, static_cast<uint8_t>(high | kEnable), high,
            low, static_cast<uint8_t>(low | kEnable), low,
        };
        esp_err_t error = i2c_master_transmit(device_, bytes, sizeof(bytes), 20);
        esp_rom_delay_us(50);
        return error;
    }

    i2c_master_bus_handle_t bus_ = nullptr;
    i2c_master_dev_handle_t device_ = nullptr;
};

void display_loop() {
    Display display;
    esp_err_t error = display.init();
    if (error != ESP_OK) {
        ESP_LOGW(kTag, "LCD 0x%02x unavailable (%s); SDA=%d SCL=%d; continuing without display",
                 kAddress, esp_err_to_name(error), kSda, kScl);
        return;
    }
    ESP_LOGI(kTag, "LCD 1602 ready: address=0x%02x SDA=%d SCL=%d; demo=kW real=W",
             kAddress, kSda, kScl);
    Frame frame{}, previous{};
    bool has_previous = false;
    while (true) {
        if (xQueueReceive(mailbox, &frame, portMAX_DELAY) != pdTRUE) continue;
        if (has_previous && !std::memcmp(&frame, &previous, sizeof(frame))) continue;
        error = display.render(frame);
        if (error != ESP_OK) {
            ESP_LOGW(kTag, "LCD write failed (%s); continuing without display", esp_err_to_name(error));
            return;
        }
        previous = frame;
        has_previous = true;
    }
}

void display_task(void*) {
    // Return through display_loop first so its I2C resources are released.
    display_loop();
    vTaskDelete(nullptr);
}

void power_text(float power, char (&text)[5]) {
    // Keep both values on one 16-column row, including large valid telemetry.
    for (int precision = 2; precision >= 0; --precision) {
        if (std::snprintf(text, sizeof(text), "%.*f", precision, power) < 5) break;
    }
}
}  // namespace

void lcd_status(const char* message) {
    if (!mailbox) return;
    Frame frame{};
    std::snprintf(frame.lines[0], sizeof(frame.lines[0]), "Solar Edge AI");
    std::snprintf(frame.lines[1], sizeof(frame.lines[1]), "%s", message);
    xQueueOverwrite(mailbox, &frame);
}

void lcd_telemetry(float solar_kw, float load_kw) {
    if (!mailbox) return;
    Frame frame{};
    char solar[5], load[5];
    power_text(solar_kw, solar);
    power_text(load_kw, load);
    float net = solar_kw - load_kw;
    const char* balance = net > 0.05f ? "SELL" : net < -0.05f ? "BUY" : "HOLD";
    std::snprintf(frame.lines[0], sizeof(frame.lines[0]), "Ps:%4s Pl:%4s", solar, load);
    std::snprintf(frame.lines[1], sizeof(frame.lines[1]), "N:%+.2fkW %s", net, balance);
    xQueueOverwrite(mailbox, &frame);
}

void lcd_start() {
    mailbox = xQueueCreate(1, sizeof(Frame));
    if (!mailbox) {
        ESP_LOGW(kTag, "LCD mailbox allocation failed; continuing without display");
        return;
    }
    lcd_status("Connecting WiFi");
    if (xTaskCreate(display_task, "solar_lcd", 4096, nullptr, 2, nullptr) != pdPASS) {
        vQueueDelete(mailbox);
        mailbox = nullptr;
        ESP_LOGW(kTag, "LCD task allocation failed; continuing without display");
    }
}

void lcd_measurements(const PowerReadings& reading, bool electrical_page) {
    if (!mailbox) return;
    Frame frame{};
    if (electrical_page || !reading.solar.valid || !reading.load.valid) {
        const ElectricalReading values[] = {reading.solar, reading.load};
        const char* labels[] = {"Ps", "Pl"};
        for (int i = 0; i < 2; ++i) {
            if (values[i].valid)
                std::snprintf(frame.lines[i], sizeof(frame.lines[i]), "%s:%5.2fV %5.*fA",
                              labels[i], values[i].voltage_v, values[i].current_a < 0 ? 2 : 3, values[i].current_a);
            else std::snprintf(frame.lines[i], sizeof(frame.lines[i]), "%s:INA219 error", labels[i]);
        }
    } else {
        char solar[5], load[5];
        power_text(reading.solar.power_w, solar);
        power_text(reading.load.power_w, load);
        const float net = reading.solar.power_w - reading.load.power_w;
        const char* balance = net > 0.05f ? "SELL" : net < -0.05f ? "BUY" : "HOLD";
        std::snprintf(frame.lines[0], sizeof(frame.lines[0]), "Ps:%4s Pl:%4sW", solar, load);
        std::snprintf(frame.lines[1], sizeof(frame.lines[1]), "N:%+.2fW %s", net, balance);
    }
    xQueueOverwrite(mailbox, &frame);
}
void lcd_temperature(const TemperatureReading& reading) {
    if (!mailbox) return;
    Frame frame{};
    std::snprintf(frame.lines[0], sizeof(frame.lines[0]), "DS18B20 GPIO27");
    if (valid_temperature(reading)) std::snprintf(frame.lines[1], sizeof(frame.lines[1]), "Temp:%+.2f C", reading.celsius);
    else std::snprintf(frame.lines[1], sizeof(frame.lines[1]), "Sensor missing");
    xQueueOverwrite(mailbox, &frame);
}
}  // namespace solar
