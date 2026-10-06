#include "solar_features.h"
#include <cassert>
#include <iostream>
#include <iomanip>
int main() {
    int64_t stamp;
    assert(!solar::parse_time("2026-02-30T10:00:00+07:00", stamp));
    assert(!solar::parse_time("2026-09-01T10:00:00+00:00", stamp));
    assert(solar::parse_time("2026-09-05T23:55:00+07:00", stamp));
    char converted[32];
    solar::format_time(stamp + 300, converted, sizeof(converted));
    assert(std::strcmp(converted, "2026-09-06T00:00:00+07:00") == 0);
    solar::History history;
    solar::Sample sample;
    std::strcpy(sample.run, "11111111111111111111111111111111");
    for (int i = 0; i < 12; ++i) {
        sample.local_seconds = stamp + i*300; sample.sequence = i;
        assert(history.add(sample) == (i == 11));
    }
    assert(!history.add(sample)); assert(history.count == 12);
    sample.local_seconds += 600; sample.sequence += 2;
    assert(!history.add(sample)); assert(history.count == 1);
    sample.connection++; sample.local_seconds += 300; sample.sequence++;
    assert(!history.add(sample)); assert(history.count == 1);
    sample.real_measurement = true; sample.local_seconds += 300; sample.sequence++;
    assert(!history.add(sample)); assert(history.count == 1); // Never mix demo and INA219 history.
    std::strcpy(sample.run, "22222222222222222222222222222222");
    assert(!history.add(sample)); assert(history.count == 1);
    std::strcpy(sample.run, "11111111111111111111111111111111");
    assert(!history.add(sample)); assert(history.count == 1);
    int count, zero; float scale;
    std::cin >> count >> scale >> zero;
    std::cout << std::setprecision(10);
    for (int c = 0; c < count; ++c) {
        solar::Sample rows[12]; float output[53];
        for (auto& row : rows) {
            std::cin >> row.local_seconds;
            for (float& value : row.values) std::cin >> value;
        }
        solar::features(rows, output);
        for (float value : output) std::cout << value << ' ';
        for (float value : output) std::cout << static_cast<int>(solar::quantize(value, scale, zero)) << ' ';
        std::cout << '\n';
    }
}
