#include "power_measurement.h"
#include "real_telemetry.h"
#include "solar_features.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <limits>

constexpr int64_t start = 1800000000; // UTC, aligned to a 5-minute boundary.
constexpr char run[] = "11111111111111111111111111111111";
const solar::PowerReadings good{{12, .25f, 3, true}, {5, .2f, 1, true}};
bool near(float actual, float expected) { return std::fabs(actual - expected) < 1e-6f; }
void print(cJSON* object) {
    assert(object);
    char* json = cJSON_PrintUnformatted(object);
    assert(json);
    std::puts(json);
    cJSON_free(json);
    cJSON_Delete(object);
}

int main(int argc, char** argv) {
    assert(argc == 2);
    if (!std::strcmp(argv[1], "decode")) {
        // 12 V, 1 A, 12 W with the original Arduino default calibration.
        const uint16_t bus = (3000 << 3) | 2;
        auto reading = solar::decode_ina219(bus, 10000, 6000);
        assert(reading.valid && near(reading.voltage_v, 12));
        assert(near(reading.current_a, 1) && near(reading.power_w, 12));
        reading = solar::decode_ina219(bus, 1, 1);
        assert(near(reading.current_a, .0001f) && near(reading.power_w, .002f));
        reading = solar::decode_ina219(bus, static_cast<uint16_t>(-10000), 6000);
        assert(reading.valid && near(reading.current_a, -1) && near(reading.power_w, -12));
        assert(!solar::forward_reading(reading));
        assert(!solar::decode_ina219(bus | 1, 10000, 6000).valid); // Math overflow.
        assert(!solar::decode_ina219(bus & ~2, 10000, 6000).valid); // No conversion yet.
        assert(!solar::decode_ina219((7000 << 3) | 2, 0, 0).valid); // 28 V, outside INA219 rating.
        assert(solar::forward_reading(solar::decode_ina219(2, 0, 0))); // A genuine zero is valid.
        reading = good.solar;
        reading.power_w = std::numeric_limits<float>::quiet_NaN();
        assert(!solar::forward_reading(reading));
    } else if (!std::strcmp(argv[1], "intervals")) {
        for (int fault = 0; fault < 5; ++fault) {
            solar::PowerInterval interval;
            solar::CompletedPowerInterval complete;
            for (int i = 0; i < 600; ++i) {
                auto reading = good;
                if (fault == 1 && i == 200) reading.load.valid = false;
                if (fault == 4 && i == 200) reading.load = {5, -.002f, -.01f, true};
                const int64_t mono = i * 500000LL + (fault == 2 && i >= 200 ? 2000000 : 0);
                const int64_t utc = start + i / 2 + (fault == 3 && i >= 200 ? 5 : 0);
                assert(!interval.add(utc, mono, reading, complete));
            }
            const bool ready = interval.add(start + 300 + (fault == 3 ? 5 : 0),
                                           300000000 + (fault == 2 ? 2000000 : 0), good, complete);
            assert(ready == (fault == 0));
            if (ready) {
                assert(complete.start_utc == start && complete.samples == 600);
                assert(near(complete.average.solar.power_w, 3));
            }
        }
        // Start halfway through an interval: publish only the following full one.
        solar::PowerInterval interval;
        solar::CompletedPowerInterval complete;
        int emitted = 0;
        for (int i = 0; i <= 900; ++i) {
            if (interval.add(start + 150 + i / 2, i * 500000LL, good, complete)) {
                ++emitted;
                assert(complete.start_utc == start + 300 && complete.samples == 600);
            }
        }
        assert(emitted == 1);
        interval.reset();
        assert(!interval.add(start, 1, good, complete));
        // A clock jumping 5 minutes forward must not fabricate a full interval.
        assert(!interval.add(start + 300, 500001, good, complete));
        assert(!interval.add(start - 300, 1000001, good, complete));
    } else if (!std::strcmp(argv[1], "zero_noise")) {
        solar::PowerInterval interval;
        solar::CompletedPowerInterval complete;
        for (int i = 0; i < 600; ++i) {
            // Reproduce the board log: ~1.8 mA solar, +/-0.3 mA unloaded load.
            solar::PowerReadings reading{{3.94f, .0018f, .006f, true},
                                         {5.04f, i % 2 ? -.0003f : .0003f, i % 2 ? -.0015f : .002f, true}};
            assert(!interval.add(start + i / 2, i * 500000LL, reading, complete));
        }
        assert(interval.add(start + 300, 300000000, good, complete));
        assert(complete.samples == 600);
        assert(near(complete.average.solar.current_a, .0018f));
        assert(near(complete.average.solar.power_w, .006f));
        assert(complete.average.load.current_a == 0 && complete.average.load.power_w == 0);
        print(solar::real_telemetry_record(run, 0, complete, start + 300));
        // A real reverse current outside the deadband remains invalid for AI.
        auto reverse = solar::interval_reading({5, -.0006f, -.003f, true});
        assert(!solar::forward_reading(reverse));
        auto suspicious = solar::interval_reading({5, -.0002f, -.1f, true});
        assert(!solar::forward_reading(suspicious));
        auto missing = solar::interval_reading({5, -.0002f, -.001f, false});
        assert(!missing.valid && !solar::forward_reading(missing));
        auto edge = solar::interval_reading({5, -.0005f, -.0025f, true});
        assert(edge.current_a == 0 && edge.power_w == 0);
        // The raw live record must retain signed readings for diagnosis.
        print(solar::live_meter_record(run, {{3.94f, .0018f, .006f, true}, {5.04f, -.0003f, -.0015f, true}}, start));
    } else if (!std::strcmp(argv[1], "telemetry")) {
        solar::PowerInterval interval;
        solar::CompletedPowerInterval complete;
        for (int i = 0; i < 600; ++i) {
            auto reading = good;
            reading.solar.power_w = i % 2 ? 4 : 2;
            assert(!interval.add(start + i / 2, i * 500000LL, reading, complete));
        }
        assert(interval.add(start + 300, 300000000, good, complete));
        print(solar::real_telemetry_record(run, 0, complete, start + 300));
        print(solar::real_telemetry_record(run, 1, complete, start + 301));
        complete.average.load.valid = false;
        assert(!solar::real_telemetry_record(run, 2, complete, start + 300));
    } else if (!std::strcmp(argv[1], "live")) {
        auto reading = good;
        reading.load.valid = false;
        print(solar::live_meter_record(run, reading, 0));
        reading.load = {0, 0, 0, true};
        print(solar::live_meter_record(run, reading, start));
    } else if (!std::strcmp(argv[1], "temperature")) {
        // Temperature failure must not suppress a valid electrical interval.
        solar::PowerInterval interval;
        solar::CompletedPowerInterval complete;
        for (int i = 0; i < 600; ++i) {
            auto reading = good;
            if (i < 300) reading.temperature = {i % 2 ? 30.f : 20.f, true};
            assert(!interval.add(start + i / 2, i * 500000LL, reading, complete));
        }
        assert(interval.add(start + 300, 300000000, good, complete));
        assert(complete.temperature_samples == 300);
        assert(complete.average.temperature.valid && near(complete.average.temperature.celsius, 25));
        print(solar::real_telemetry_record(run, 0, complete, start + 300));
        complete.temperature_samples = 0;
        complete.average.temperature = {};
        print(solar::real_telemetry_record(run, 1, complete, start + 300));
        auto live = good;
        live.temperature = {-10.f, true};
        print(solar::live_meter_record(run, live, start));
        live.temperature = {126.f, true};
        print(solar::live_meter_record(run, live, start));
        assert(!solar::valid_temperature({std::numeric_limits<float>::quiet_NaN(), true}));
        // The next interval must not inherit the preceding interval's temperature.
        for (int i = 1; i < 600; ++i)
            assert(!interval.add(start + 300 + i / 2, 300000000 + i * 500000LL, good, complete));
        assert(interval.add(start + 600, 600000000, good, complete));
        assert(complete.temperature_samples == 0 && !complete.average.temperature.valid);
    } else if (!std::strcmp(argv[1], "window")) {
        // Fast real mode: ten 500 ms reads become one accelerated 5-minute sample.
        solar::PowerWindow window;
        solar::CompletedPowerInterval complete;
        window.reset();
        for (int i = 0; i < 10; ++i) {
            auto reading = good;
            reading.solar.power_w = i % 2 ? 4 : 2;
            reading.temperature = {30.f, true};
            window.add(reading);
        }
        complete.start_utc = start;
        assert(window.finish(complete) && complete.samples == 10 && complete.temperature_samples == 10);
        assert(near(complete.average.solar.power_w, 3) && near(complete.average.load.power_w, 1));
        print(solar::real_telemetry_record(run, 0, complete, start + 5, 5));
        // Faulty reads are left out of the average instead of discarding the window:
        // a sensor error, and reverse solar current just beyond the deadband.
        for (int i = 0; i < 10; ++i) {
            auto reading = good;
            if (i == 3) reading.load.valid = false;
            if (i == 6) reading.solar = {.3f, -.0006f, -.00018f, true};
            window.add(reading);
        }
        assert(window.finish(complete) && complete.samples == 8);
        assert(near(complete.average.solar.power_w, 3) && near(complete.average.load.power_w, 1));
        // Too few good reads discards the window; the next one starts clean.
        for (int i = 0; i < 10; ++i) {
            auto reading = good;
            if (i >= 4) reading.solar.valid = false;
            window.add(reading);
        }
        assert(!window.finish(complete));
        for (int i = 0; i < 5; ++i) window.add(good);
        assert(window.finish(complete) && complete.samples == 5 && complete.temperature_samples == 0);
        // Accelerated samples must not share AI history with 5-minute samples.
        solar::History history;
        solar::Sample sample;
        std::strcpy(sample.run, run);
        sample.real_measurement = true;
        for (int i = 0; i < 12; ++i) {
            sample.sequence = i;
            sample.local_seconds = start + i * 300;
            sample.accelerated = i >= 6;
            assert(!history.add(sample));
        }
        assert(history.count == 6);
    } else if (!std::strcmp(argv[1], "history")) {
        solar::History history;
        solar::Sample sample;
        std::strcpy(sample.run, run);
        for (int i = 0; i < 12; ++i) {
            sample.sequence = i;
            sample.local_seconds = start + i * 300;
            assert(history.add(sample) == (i == 11));
        }
        std::strcpy(sample.run, "22222222222222222222222222222222");
        sample.sequence = 0;
        sample.local_seconds = start;
        assert(!history.add(sample) && history.count == 1); // Real run cannot use demo history.
        std::strcpy(sample.run, run);
        sample.sequence = 12;
        sample.local_seconds = start + 12 * 300;
        assert(!history.add(sample) && history.count == 1); // Delayed demo echo stays retired.
    } else return 1;
}
