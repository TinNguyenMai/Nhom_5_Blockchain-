#include "temperature_sensor.h"
#include "ds18b20.h"
#include "onewire_bus.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace solar {
namespace {
constexpr char kTag[] = "solar_temperature";
constexpr int kGpio = 27;
constexpr int64_t kFreshUs = 5000000;
portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
TemperatureReading latest;
int64_t sampled_us = 0;

void update(TemperatureReading reading) {
    portENTER_CRITICAL(&lock);
    latest = reading;
    sampled_us = esp_timer_get_time();
    portEXIT_CRITICAL(&lock);
}

esp_err_t discover(onewire_bus_handle_t bus, ds18b20_device_handle_t& sensor) {
    onewire_device_iter_handle_t iter = nullptr;
    esp_err_t error = onewire_new_device_iter(bus, &iter);
    if (error != ESP_OK) return error;
    onewire_device_t device{};
    while ((error = onewire_device_iter_get_next(iter, &device)) == ESP_OK) {
        ds18b20_config_t config{};
        error = ds18b20_new_device_from_enumeration(&device, &config, &sensor);
        if (error == ESP_OK) {
            ESP_LOGI(kTag, "DS18B20 ready: GPIO27 ROM=%016llx", static_cast<unsigned long long>(device.address));
            break;
        }
        if (error != ESP_ERR_NOT_SUPPORTED) break;
    }
    onewire_del_device_iter(iter);
    return error;
}

void temperature_task(void*) {
    onewire_bus_handle_t bus = nullptr;
    ds18b20_device_handle_t sensor = nullptr;
    while (true) {
        esp_err_t error = ESP_OK;
        if (!bus) {
            onewire_bus_config_t config{};
            config.bus_gpio_num = kGpio;
            onewire_bus_rmt_config_t rmt{};
            rmt.max_rx_bytes = 10;
            error = onewire_new_bus_rmt(&config, &rmt, &bus);
        }
        if (error == ESP_OK && !sensor) error = discover(bus, sensor);
        if (error == ESP_OK) error = ds18b20_trigger_temperature_conversion(sensor);
        float value = 0;
        if (error == ESP_OK) error = ds18b20_get_temperature(sensor, &value);
        TemperatureReading reading{value, error == ESP_OK};
        if (!valid_temperature(reading)) {
            update({});
            ESP_LOGW(kTag, "DS18B20 unavailable/invalid (%s); retrying; electrical data and AI continue", esp_err_to_name(error));
            if (sensor) { ds18b20_del_device(sensor); sensor = nullptr; }
            vTaskDelay(pdMS_TO_TICKS(5000));
        } else {
            update(reading);
            vTaskDelay(pdMS_TO_TICKS(1200)); // 12-bit conversion adds up to 800 ms.
        }
    }
}
}  // namespace

void temperature_start() {
    if (xTaskCreate(temperature_task, "solar_temp", 4096, nullptr, 2, nullptr) != pdPASS)
        ESP_LOGW(kTag, "Temperature task unavailable; continuing without DS18B20");
}

TemperatureReading temperature_snapshot() {
    TemperatureReading reading;
    int64_t stamp;
    portENTER_CRITICAL(&lock);
    reading = latest;
    stamp = sampled_us;
    portEXIT_CRITICAL(&lock);
    if (!stamp || esp_timer_get_time() - stamp > kFreshUs) return {};
    return reading;
}
}  // namespace solar
