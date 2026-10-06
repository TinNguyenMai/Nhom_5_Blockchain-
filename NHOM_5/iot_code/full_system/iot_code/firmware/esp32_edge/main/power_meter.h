#pragma once
#include "i2c_bus.h"
#include "power_measurement.h"

namespace solar {
class PowerMeters {
public:
    PowerReadings read();
private:
    ElectricalReading read_channel(int channel);
    i2c_master_dev_handle_t devices_[2]{};
    int64_t retry_us_[2]{};
    int64_t log_us_[2]{};
};
}
