#include "power_meter.h"
#include "esp_log.h"
#include "esp_timer.h"

namespace solar {
namespace {
constexpr uint16_t kCalibration = 4096; // 0.1-ohm shunt, 100 uA current LSB.
constexpr uint16_t kConfiguration = 0x399f; // PGA 320 mV, 12-bit continuous shunt+bus.
esp_err_t write_register(i2c_master_dev_handle_t device, uint8_t address, uint16_t value) {
    const uint8_t bytes[] = {address, static_cast<uint8_t>(value >> 8), static_cast<uint8_t>(value)};
    return i2c_master_transmit(device, bytes, sizeof(bytes), 20);
}
esp_err_t read_register(i2c_master_dev_handle_t device, uint8_t address, uint16_t& value) {
    uint8_t bytes[2];
    esp_err_t error = i2c_master_transmit_receive(device, &address, 1, bytes, 2, 20);
    if (error == ESP_OK) value = (static_cast<uint16_t>(bytes[0]) << 8) | bytes[1];
    return error;
}
}

ElectricalReading PowerMeters::read_channel(int channel) {
    const uint16_t address = channel ? 0x41 : 0x40;
    const int64_t now = esp_timer_get_time();
    if (!i2c_bus()) return {};
    esp_err_t error = ESP_OK;
    if (!devices_[channel]) {
        if (now < retry_us_[channel]) return {};
        retry_us_[channel] = now + 5000000;
        error = i2c_master_probe(i2c_bus(), address, 20);
        if (error == ESP_OK) {
            i2c_device_config_t config{};
            config.dev_addr_length = I2C_ADDR_BIT_LEN_7;
            config.device_address = address;
            config.scl_speed_hz = 100000;
            error = i2c_master_bus_add_device(i2c_bus(), &config, &devices_[channel]);
        }
        if (error == ESP_OK) error = write_register(devices_[channel], 5, kCalibration);
        if (error == ESP_OK) error = write_register(devices_[channel], 0, kConfiguration);
        if (error == ESP_OK) {
            ESP_LOGI("solar_meter", "INA219 ready: address=0x%02x shunt=0.1ohm SDA=21 SCL=22", address);
            return {}; // First conversion completes before the next 500-ms poll.
        }
    } else {
        uint16_t config, bus, current, power;
        error = read_register(devices_[channel], 0, config);
        if (error == ESP_OK && config != kConfiguration) {
            error = write_register(devices_[channel], 5, kCalibration);
            if (error == ESP_OK) error = write_register(devices_[channel], 0, kConfiguration);
            if (error == ESP_OK) return {}; // Recover a sensor reset.
        }
        // Restore calibration after a supply transient, as the Arduino driver does.
        if (error == ESP_OK) error = write_register(devices_[channel], 5, kCalibration);
        if (error == ESP_OK) error = read_register(devices_[channel], 2, bus);
        if (error == ESP_OK) error = read_register(devices_[channel], 4, current);
        if (error == ESP_OK) error = read_register(devices_[channel], 3, power);
        if (error == ESP_OK) {
            ElectricalReading reading = decode_ina219(bus, current, power);
            if (reading.valid) return reading;
            error = ESP_ERR_INVALID_RESPONSE;
        }
    }
    if (now >= log_us_[channel]) {
        ESP_LOGW("solar_meter", "INA219 0x%02x unavailable/invalid (%s); reading omitted", address, esp_err_to_name(error));
        log_us_[channel] = now + 5000000;
    }
    if (devices_[channel] && error != ESP_ERR_INVALID_RESPONSE) {
        i2c_master_bus_rm_device(devices_[channel]);
        devices_[channel] = nullptr;
        retry_us_[channel] = now + 5000000;
    }
    return {};
}
PowerReadings PowerMeters::read() { return {read_channel(0), read_channel(1)}; }
}
