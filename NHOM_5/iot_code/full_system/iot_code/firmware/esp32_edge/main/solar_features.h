#pragma once
// Feature contract v1. Unique filename avoids the C library's features.h.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>

namespace solar {
constexpr int kWindow = 12;
constexpr int kFeatures = 53;
constexpr int kStep = 300;
struct Sample {
    char run[33]{};
    char event[96]{};
    int64_t local_seconds = 0; // Vietnam wall time encoded as seconds; NOT UTC.
    int32_t sequence = 0;
    uint32_t connection = 0;
    bool real_measurement = false;
    bool accelerated = false; // One logical 5-minute step per few wall-clock seconds.
    float values[4]{}; // solar kW, load kW, irradiance W/m2, cloud [0,1]
};

inline bool parse_time(const char* value, int64_t& result) {
    if (!value || std::strlen(value) != 25 || std::strcmp(value + 19, "+07:00")) return false;
    int y, m, d, h, minute, s;
    if (std::sscanf(value, "%4d-%2d-%2dT%2d:%2d:%2d", &y, &m, &d, &h, &minute, &s) != 6) return false;
    if (y < 2020 || y > 2099 || m < 1 || m > 12 || d < 1 || h < 0 || h > 23 || minute < 0 || minute > 59 || s < 0 || s > 59) return false;
    auto leap = [](int year) { return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0); };
    const int months[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if (d > months[m-1] + (m == 2 && leap(y))) return false;
    int64_t days = 0;
    for (int year = 1970; year < y; ++year) days += 365 + leap(year);
    for (int month = 1; month < m; ++month) days += months[month-1] + (month == 2 && leap(y));
    result = (days + d - 1) * 86400 + h * 3600 + minute * 60 + s;
    // Reject noncanonical date strings, including whitespace and loose digits.
    char canonical[64];
    std::snprintf(canonical, sizeof(canonical), "%04d-%02d-%02dT%02d:%02d:%02d+07:00", y,m,d,h,minute,s);
    return std::strcmp(canonical, value) == 0;
}

inline void format_time(int64_t local, char* target, size_t size) {
    const time_t seconds = static_cast<time_t>(local);
    struct tm parts{};
#ifdef _WIN32
    gmtime_s(&parts, &seconds);
#else
    gmtime_r(&seconds, &parts);
#endif
    std::strftime(target, size, "%Y-%m-%dT%H:%M:%S+07:00", &parts);
}

inline void features(const Sample* rows, float* output) {
    const float scales[] = {4.f, 2.f, 1000.f, 1.f};
    for (int i = 0; i < kWindow; ++i)
        for (int j = 0; j < 4; ++j) output[4*i+j] = rows[i].values[j] / scales[j];
    int64_t midpoint = rows[kWindow-1].local_seconds + kStep + kStep / 2;
    double angle = 6.2831853071795864769 * (midpoint % 86400) / 86400.;
    output[48] = std::sin(angle); output[49] = std::cos(angle);
    output[50] = std::sin(2 * angle); output[51] = std::cos(2 * angle);
    int sunday_zero = static_cast<int>((midpoint / 86400 + 4) % 7);
    output[52] = (sunday_zero == 0 || sunday_zero == 6) ? 1.f : 0.f;
}

inline int8_t quantize(float value, float scale, int zero) {
    float q = std::round(value / scale) + zero;
    return static_cast<int8_t>(std::max(-128.f, std::min(127.f, q)));
}

class History {
public:
    Sample rows[kWindow]{};
    int count = 0;
    bool add(const Sample& next) {
        for (const auto& old : retired_) if (std::strcmp(old, next.run) == 0) return false;
        if (count) {
            const Sample& last = rows[count-1];
            if (std::strcmp(last.run, next.run)) {
                std::strcpy(retired_[retired_index_++ % 8], last.run);
                count = 0;
            } else {
                if (next.local_seconds <= last.local_seconds || next.sequence <= last.sequence) return false;
                if (next.local_seconds - last.local_seconds != kStep || next.sequence != last.sequence + 1 || next.connection != last.connection || next.real_measurement != last.real_measurement || next.accelerated != last.accelerated) count = 0;
            }
        }
        if (count == kWindow) {
            for (int i = 1; i < kWindow; ++i) rows[i-1] = rows[i];
            --count;
        }
        rows[count++] = next;
        return count == kWindow;
    }
private:
    char retired_[8][33]{};
    unsigned retired_index_ = 0;
};
} // namespace solar
