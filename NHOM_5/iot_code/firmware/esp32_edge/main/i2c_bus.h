#pragma once
#include "driver/i2c_master.h"

namespace solar {
// The application owns this bus for its lifetime; LCD and meters share it.
esp_err_t i2c_start();
i2c_master_bus_handle_t i2c_bus();
}
