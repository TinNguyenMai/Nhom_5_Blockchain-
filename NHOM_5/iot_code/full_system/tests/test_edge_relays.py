"""Exercise production mode/actuator handlers with GPIO and clock stubs."""
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


def firmware_function(source, name):
    match = re.search(r"void " + name + r"\([^)]*\)\s*\{", source)
    if not match:
        raise AssertionError(f"Missing production handler {name}")
    depth = 1
    end = match.end()
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[match.start():end]


@unittest.skipUnless(shutil.which("g++"), "Requires a host C++ compiler")
class EdgeRelayTests(unittest.TestCase):
    def test_real_load_mode_transitions_settlement_guard_and_timeout(self):
        source = (ROOT / "iot_code/firmware/esp32_edge/main/main.cc").read_text()
        handlers = "\n".join(firmware_function(source, name) for name in
                             ("set_idle_relays", "apply_actuator", "handle_command",
                              "handle_actuator_command", "actuator_task"))
        stub = r'''
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
constexpr int RELAY1 = 4, RELAY2 = 25, STATUS_LED = 2;
constexpr char TAG[] = "test";
enum DemoScenario { DEMO_AUTO, DEMO_SELL, DEMO_BUY, DEMO_HOLD };
volatile bool demo_enabled = true, new_run_requested = false, fast_real = true;
volatile DemoScenario demo_scenario = DEMO_AUTO;
int levels[32]{};
int64_t now_us = 1000000, actuator_deadline_us = 0;
int actuator_round = 0, acknowledgements = 0;
char actuator_action[8] = "off";
char last_ack[16]{}, lcd_message[32]{};
void gpio_set_level(int pin, int value) { levels[pin] = value; }
int gpio_get_level(int pin) { return levels[pin]; }
int64_t esp_timer_get_time() { return now_us; }
void publish_actuator_status(const char* state) {
    ++acknowledgements;
    std::strcpy(last_ack, state);
}
void snapshot_run(char (&run)[33]) { std::memset(run, '1', 32); run[32] = 0; }
const char* scenario_name(DemoScenario) { return "auto"; }
namespace solar { void lcd_status(const char* message) { std::strcpy(lcd_message, message); } }
void log_output(const char*, const char*, ...) {}
#define ESP_LOGI(tag, ...) log_output(tag, __VA_ARGS__)
#define ESP_LOGW(tag, ...) log_output(tag, __VA_ARGS__)
#define pdMS_TO_TICKS(value) (value)
struct EndTick {};
void vTaskDelay(int) { throw EndTick{}; }
'''
        checks = r'''
int main() {
    set_idle_relays(); // Demo mode idle: local and P2P paths disconnected.
    assert(levels[4] == 1 && levels[25] == 1);
    handle_actuator_command("settled:buy:7:10");
    assert(levels[4] == 0 && levels[25] == 0 && actuator_deadline_us > now_us);
    assert(acknowledgements == 1);
    handle_command("demo off"); // Switching during a trade cancels its P2P output/timer.
    assert(!demo_enabled && new_run_requested);
    assert(levels[4] == 0 && levels[25] == 1 && levels[2] == 0);
    assert(actuator_deadline_us == 0 && !std::strcmp(actuator_action, "off"));
    assert(!std::strcmp(lcd_message, "Reading INA219"));
    handle_actuator_command("settled:sell:8:10"); // Incoming trade must not cut local power in real mode.
    assert(levels[4] == 0 && levels[25] == 1 && acknowledgements == 1);
    handle_command("demo status");
    assert(levels[4] == 0 && levels[25] == 1);
    new_run_requested = false;
    handle_command("real slow"); // Sampling cadence restarts AI history, relays untouched.
    assert(!fast_real && new_run_requested && levels[4] == 0 && levels[25] == 1);
    handle_command("real fast");
    assert(fast_real);
    handle_command("demo on");
    assert(demo_enabled && levels[4] == 1 && levels[25] == 1);
    handle_actuator_command("bad");
    assert(levels[4] == 1 && levels[25] == 1 && acknowledgements == 1);
    handle_actuator_command("settled:sell:9:10");
    assert(levels[4] == 1 && levels[25] == 0);
    now_us = actuator_deadline_us;
    try { actuator_task(nullptr); } catch (EndTick&) {}
    assert(levels[4] == 1 && levels[25] == 1 && actuator_deadline_us == 0);
    assert(!std::strcmp(last_ack, "timeout"));
    handle_command("demo off");
    // Even a stale expiry must restore the real-mode local supply, not disconnect it.
    actuator_deadline_us = now_us - 1;
    try { actuator_task(nullptr); } catch (EndTick&) {}
    assert(levels[4] == 0 && levels[25] == 1 && actuator_deadline_us == 0);
}
'''
        with tempfile.TemporaryDirectory() as temp:
            cpp = Path(temp) / "relays.cc"
            binary = Path(temp) / "relays.exe"
            cpp.write_text(stub + handlers + checks)
            build = subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                                    str(cpp), "-o", str(binary)], capture_output=True, text=True)
            self.assertEqual(build.returncode, 0, build.stderr)
            result = subprocess.run([str(binary)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
