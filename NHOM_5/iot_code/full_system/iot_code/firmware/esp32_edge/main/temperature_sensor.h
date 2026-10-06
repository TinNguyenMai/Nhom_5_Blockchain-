#pragma once
#include "power_measurement.h"

namespace solar {
// One externally powered DS18B20 on GPIO27. Conversion waits run on a dedicated
// task, so INA219's 500-ms sampling, inference and MQTT never wait for it.
void temperature_start();
TemperatureReading temperature_snapshot();
}  // namespace solar
