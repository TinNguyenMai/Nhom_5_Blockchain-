#pragma once
#include "power_measurement.h"

namespace solar {
// Optional LCD 1602 / PCF8574: address 0x27, SDA GPIO21, SCL GPIO22.
// Producers only update a mailbox; all I2C transfers run on the LCD task.
void lcd_start();
void lcd_status(const char* message);
void lcd_telemetry(float solar_kw, float load_kw);
void lcd_measurements(const PowerReadings& reading, bool electrical_page);
void lcd_temperature(const TemperatureReading& reading);
}  // namespace solar
