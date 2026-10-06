#pragma once
#include <cmath>
#include <cstdint>

namespace solar {
constexpr int64_t kMeasurementInterval = 300;
constexpr float kPanelRatedWatts = 3.f;  // Same small panel as blockchainV2.ino.
constexpr float kZeroCurrentDeadbandAmps = 0.0005f; // Only interval/AI data; raw meter readings stay signed.
struct ElectricalReading {
    float voltage_v = 0, current_a = 0, power_w = 0;
    bool valid = false;
};
struct TemperatureReading { float celsius = 0; bool valid = false; };
inline bool valid_temperature(const TemperatureReading& reading) {
    return reading.valid && std::isfinite(reading.celsius) && reading.celsius >= -55 && reading.celsius <= 125;
}
struct PowerReadings { ElectricalReading solar, load; TemperatureReading temperature{}; };

// Adafruit INA219's default 0.1-ohm shunt calibration: 100 uA and 2 mW/LSB.
inline ElectricalReading decode_ina219(uint16_t bus, uint16_t current, uint16_t power) {
    ElectricalReading value;
    if ((bus & 1) || !(bus & 2)) return value; // Overflow / conversion not ready.
    value.voltage_v = (bus >> 3) * 0.004f;
    int32_t signed_current = current < 0x8000 ? current : static_cast<int32_t>(current) - 65536;
    value.current_a = signed_current * 0.0001f;
    value.power_w = value.current_a < 0 ? value.voltage_v * value.current_a : power * 0.002f;
    value.valid = value.voltage_v <= 26.f;
    return value;
}
inline bool forward_reading(const ElectricalReading& value) {
    return value.valid && std::isfinite(value.voltage_v) && std::isfinite(value.current_a) &&
           std::isfinite(value.power_w) && value.voltage_v >= 0 && value.voltage_v <= 26 &&
           value.current_a >= 0 && value.power_w >= 0;
}
inline ElectricalReading interval_reading(ElectricalReading value) {
    // Near zero, the 0.1-ohm shunt's offset/quantization can alternate sign.
    // Require both current and power to be small; never mask sensor failures or
    // significant reverse current. 2 mW allows one power-register LSB.
    if (value.valid && std::isfinite(value.voltage_v) && std::isfinite(value.current_a) &&
        std::isfinite(value.power_w) && value.voltage_v >= 0 && value.voltage_v <= 26 &&
        std::fabs(value.current_a) <= kZeroCurrentDeadbandAmps &&
        std::fabs(value.power_w) <= value.voltage_v * kZeroCurrentDeadbandAmps + 0.002f) {
        value.current_a = 0;
        value.power_w = 0;
    }
    return value;
}
struct CompletedPowerInterval {
    int64_t start_utc = 0;
    uint32_t samples = 0;
    uint32_t temperature_samples = 0;
    PowerReadings average;
};

// Skip initial partial intervals, time jumps, sampling gaps and faulty readings.
// A full interval is needed before converting average power to 5-minute energy.
class PowerInterval {
public:
    void reset() { started_ = false; }
    bool add(int64_t utc, int64_t monotonic_us, const PowerReadings& reading,
             CompletedPowerInterval& complete) {
        const int64_t slot = utc / kMeasurementInterval * kMeasurementInterval;
        bool ready = false;
        if (!started_) {
            begin(slot, utc == slot);
            started_ = true;
        } else {
            const int64_t elapsed = monotonic_us - last_us_;
            const int64_t clock_error = (utc - last_utc_) * 1000000 - elapsed;
            const bool continuous = elapsed > 0 && elapsed <= 1500000 &&
                                    clock_error >= -2000000 && clock_error <= 2000000;
            if (!continuous) clean_ = false;
            if (slot != start_) {
                if (slot == start_ + kMeasurementInterval && clean_ && count_) {
                    complete.start_utc = start_;
                    complete.samples = count_;
                    complete.average.solar = averaged(0);
                    complete.average.load = averaged(3);
                    complete.temperature_samples = temperature_count_;
                    complete.average.temperature = temperature_count_ ?
                        TemperatureReading{static_cast<float>(temperature_sum_ / temperature_count_), true} : TemperatureReading{};
                    ready = true;
                }
                const bool adjacent = slot == start_ + kMeasurementInterval;
                begin(slot, adjacent && continuous && utc - slot <= 1);
            }
        }
        last_us_ = monotonic_us;
        last_utc_ = utc;
        const ElectricalReading solar = interval_reading(reading.solar);
        const ElectricalReading load = interval_reading(reading.load);
        if (!forward_reading(solar) || !forward_reading(load)) clean_ = false;
        else {
            sums_[0] += solar.voltage_v;
            sums_[1] += solar.current_a;
            sums_[2] += solar.power_w;
            sums_[3] += load.voltage_v;
            sums_[4] += load.current_a;
            sums_[5] += load.power_w;
            ++count_;
            if (valid_temperature(reading.temperature)) {
                temperature_sum_ += reading.temperature.celsius;
                ++temperature_count_;
            }
        }
        return ready;
    }
private:
    void begin(int64_t slot, bool clean) {
        start_ = slot; clean_ = clean; count_ = temperature_count_ = 0; temperature_sum_ = 0;
        for (double& sum : sums_) sum = 0;
    }
    ElectricalReading averaged(int index) const {
        return {static_cast<float>(sums_[index] / count_),
                static_cast<float>(sums_[index+1] / count_),
                static_cast<float>(sums_[index+2] / count_), true};
    }
    double sums_[6]{};
    uint32_t count_ = 0;
    uint32_t temperature_count_ = 0;
    double temperature_sum_ = 0;
    int64_t start_ = 0, last_us_ = 0, last_utc_ = 0;
    bool started_ = false, clean_ = false;
};

// Fast real mode: average a short wall-clock window of sensor reads. The caller
// owns the window length. Faulty reads (sensor error, reverse current beyond the
// deadband) are left out of the average; a window with too few good reads is
// discarded, so shunt noise around zero cannot keep restarting the AI history.
constexpr uint32_t kMinWindowSamples = 5;
class PowerWindow {
public:
    void reset() {
        count_ = temperature_count_ = 0; temperature_sum_ = 0;
        for (double& sum : sums_) sum = 0;
    }
    void add(const PowerReadings& reading) {
        const ElectricalReading solar = interval_reading(reading.solar);
        const ElectricalReading load = interval_reading(reading.load);
        if (!forward_reading(solar) || !forward_reading(load)) return;
        const float values[] = {solar.voltage_v, solar.current_a, solar.power_w,
                                load.voltage_v, load.current_a, load.power_w};
        for (int i = 0; i < 6; ++i) sums_[i] += values[i];
        ++count_;
        if (valid_temperature(reading.temperature)) {
            temperature_sum_ += reading.temperature.celsius;
            ++temperature_count_;
        }
    }
    bool finish(CompletedPowerInterval& complete) {
        const bool ready = count_ >= kMinWindowSamples;
        if (ready) {
            complete.samples = count_;
            complete.average.solar = averaged(0);
            complete.average.load = averaged(3);
            complete.temperature_samples = temperature_count_;
            complete.average.temperature = temperature_count_ ?
                TemperatureReading{static_cast<float>(temperature_sum_ / temperature_count_), true} : TemperatureReading{};
        }
        reset();
        return ready;
    }
private:
    ElectricalReading averaged(int index) const {
        return {static_cast<float>(sums_[index] / count_),
                static_cast<float>(sums_[index+1] / count_),
                static_cast<float>(sums_[index+2] / count_), true};
    }
    double sums_[6]{};
    uint32_t count_ = 0, temperature_count_ = 0;
    double temperature_sum_ = 0;
};
}
