idf_component_register(SRCS "main.cc" "lcd_display.cc" "i2c_bus.cc" "power_meter.cc" "real_telemetry.cc" "temperature_sensor.cc" INCLUDE_DIRS "."
    REQUIRES driver esp_driver_i2c esp_wifi esp_event esp_netif nvs_flash mqtt json esp_timer esp-tflite-micro ds18b20 onewire_bus)
target_compile_features(${COMPONENT_LIB} PRIVATE cxx_std_17)
