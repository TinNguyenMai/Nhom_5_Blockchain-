#include "real_telemetry.h"
#include "solar_features.h"

namespace solar {
namespace {
void timestamp(cJSON* object, const char* key, int64_t utc) {
    if (!utc) { cJSON_AddNullToObject(object, key); return; }
    char stamp[32];
    format_time(utc + 7 * 3600, stamp, sizeof(stamp));
    cJSON_AddStringToObject(object, key, stamp);
}
void electrical(cJSON* object, const char* prefix, const ElectricalReading& reading) {
    const char* suffixes[] = {"voltage_v", "current_a", "power_w"};
    const float values[] = {reading.voltage_v, reading.current_a, reading.power_w};
    char key[40];
    for (int i = 0; i < 3; ++i) {
        std::snprintf(key, sizeof(key), "%s_%s", prefix, suffixes[i]);
        if (reading.valid) cJSON_AddNumberToObject(object, key, values[i]);
        else cJSON_AddNullToObject(object, key);
    }
    std::snprintf(key, sizeof(key), "%s_valid", prefix);
    cJSON_AddBoolToObject(object, key, reading.valid);
}
}
cJSON* live_meter_record(const char* run, const PowerReadings& reading, int64_t utc) {
    cJSON* object = cJSON_CreateObject();
    if (!object) return nullptr;
    cJSON_AddNumberToObject(object, "schema_version", 1);
    cJSON_AddStringToObject(object, "household_id", "home_01");
    cJSON_AddStringToObject(object, "run_id", run);
    cJSON_AddStringToObject(object, "data_mode", "real");
    cJSON_AddStringToObject(object, "source", "ina219");
    cJSON_AddBoolToObject(object, "time_synced", utc != 0);
    timestamp(object, "timestamp", utc);
    electrical(object, "solar", reading.solar);
    electrical(object, "load", reading.load);
    const bool temperature_ok = valid_temperature(reading.temperature);
    cJSON_AddBoolToObject(object, "temperature_valid", temperature_ok);
    cJSON_AddStringToObject(object, "temperature_source", temperature_ok ? "ds18b20" : "unavailable");
    if (temperature_ok) cJSON_AddNumberToObject(object, "temperature_c", reading.temperature.celsius);
    else cJSON_AddNullToObject(object, "temperature_c");
    return object;
}
cJSON* real_telemetry_record(const char* run, uint32_t sequence,
                             const CompletedPowerInterval& interval, int64_t published_utc,
                             int sampling_seconds) {
    if (!interval.samples || !forward_reading(interval.average.solar) ||
        !forward_reading(interval.average.load)) return nullptr;
    cJSON* object = cJSON_CreateObject();
    if (!object) return nullptr;
    char event[96];
    std::snprintf(event, sizeof(event), "%s:home_01:%lu", run, static_cast<unsigned long>(sequence));
    cJSON_AddNumberToObject(object, "schema_version", 1);
    cJSON_AddStringToObject(object, "household_id", "home_01");
    cJSON_AddStringToObject(object, "event_id", event);
    cJSON_AddStringToObject(object, "run_id", run);
    timestamp(object, "timestamp", interval.start_utc);
    timestamp(object, "published_at", published_utc);
    cJSON_AddNumberToObject(object, "interval_seconds", kMeasurementInterval);
    const float solar_kw = interval.average.solar.power_w / 1000.f;
    const float load_kw = interval.average.load.power_w / 1000.f;
    const float net = solar_kw - load_kw;
    cJSON_AddNumberToObject(object, "solar_power_kw", solar_kw);
    cJSON_AddNumberToObject(object, "load_power_kw", load_kw);
    cJSON_AddNumberToObject(object, "net_power_kw", net);
    cJSON_AddNumberToObject(object, "solar_energy_kwh", solar_kw / 12.f);
    cJSON_AddNumberToObject(object, "load_energy_kwh", load_kw / 12.f);
    cJSON_AddNumberToObject(object, "surplus_energy_kwh", std::max(0.f, net) / 12.f);
    cJSON_AddNumberToObject(object, "deficit_energy_kwh", std::max(0.f, -net) / 12.f);
    // Same weather estimates as the Arduino reference, explicitly labelled.
    const float irradiance = std::min(1500.f, interval.average.solar.power_w / kPanelRatedWatts * 1000.f);
    const int64_t local_midpoint = interval.start_utc + 7 * 3600 + 150;
    const float hour = (local_midpoint % 86400) / 3600.f;
    const float clear_sky = hour > 6 && hour < 18 ? 1000.f * std::sin(3.14159265f * (hour - 6) / 12.f) : 0;
    const float cloud = clear_sky >= 1 ? std::max(0.f, std::min(1.f, (1 - irradiance / clear_sky) / 0.75f)) : 0;
    cJSON_AddNumberToObject(object, "irradiance_w_m2", irradiance);
    cJSON_AddNumberToObject(object, "cloud_cover", cloud);
    const bool temperature_ok = interval.temperature_samples > 0 && valid_temperature(interval.average.temperature);
    // Schema v1 requires a numeric value. Zero is explicitly marked unavailable,
    // never represented as a measured temperature when the sensor is missing.
    cJSON_AddNumberToObject(object, "temperature_c", temperature_ok ? interval.average.temperature.celsius : 0);
    cJSON_AddStringToObject(object, "weather_source", "estimated_from_power");
    cJSON_AddStringToObject(object, "temperature_source", temperature_ok ? "ds18b20" : "unavailable");
    cJSON_AddBoolToObject(object, "temperature_valid", temperature_ok);
    cJSON_AddNumberToObject(object, "temperature_samples", temperature_ok ? interval.temperature_samples : 0);
    cJSON_AddStringToObject(object, "data_mode", "real");
    cJSON_AddStringToObject(object, "demo_scenario", "none");
    if (sampling_seconds < kMeasurementInterval) {
        cJSON_AddStringToObject(object, "time_mode", "accelerated");
        cJSON_AddNumberToObject(object, "sampling_seconds", sampling_seconds);
    }
    cJSON_AddNumberToObject(object, "measurement_samples", interval.samples);
    cJSON_AddNumberToObject(object, "zero_current_deadband_a", kZeroCurrentDeadbandAmps);
    cJSON_AddNumberToObject(object, "solar_voltage_v", interval.average.solar.voltage_v);
    cJSON_AddNumberToObject(object, "solar_current_a", interval.average.solar.current_a);
    cJSON_AddNumberToObject(object, "load_voltage_v", interval.average.load.voltage_v);
    cJSON_AddNumberToObject(object, "load_current_a", interval.average.load.current_a);
    return object;
}
}
