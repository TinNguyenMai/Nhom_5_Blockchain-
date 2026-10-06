#pragma once
#include "cJSON.h"
#include "power_measurement.h"

namespace solar {
// sampling_seconds is the wall-clock span behind one logical 5-minute sample;
// anything shorter than the interval is labelled as accelerated time.
cJSON* real_telemetry_record(const char* run, uint32_t sequence,
                             const CompletedPowerInterval& interval, int64_t published_utc,
                             int sampling_seconds = kMeasurementInterval);
cJSON* live_meter_record(const char* run, const PowerReadings& reading, int64_t utc);
}
