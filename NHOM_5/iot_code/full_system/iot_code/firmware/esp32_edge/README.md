# Firmware một ESP32: INA219 + DS18B20 + LCD + TFLite Micro + relay

Đây là firmware dùng cho luồng đầy đủ trên một ESP32 trần:

```text
Mẫu mô phỏng mỗi 5s (hoặc INA219 thật mỗi 5 phút) → bộ đệm 12 mẫu → TFLite Micro INT8
→ MQTT prediction → cầu nối hybrid → smart contract + 11 hộ mô phỏng
```

**Mặc định khi khởi động (từ 05/10/2026): đo thật, 5 giây/mẫu.** Board đọc hai INA219,
lấy trung bình mỗi 5 giây thành một mẫu (`data_mode=real`, `time_mode=accelerated`,
`sampling_seconds=5`), chạy AI sau 12 mẫu (khoảng 60 giây) và gửi cả số đo lẫn dự báo
qua MQTT. Lệnh qua `solar/home_01/control`: `real fast` (mặc định), `real slow` (trung
bình 5 phút, cần 60–65 phút cho dự báo đầu tiên), `demo on` (mẫu mô phỏng 5 giây),
`demo off` (về đo thật). Các đoạn bên dưới mô tả "demo mặc định bật" là của bản trước;
chi tiết bản hiện tại ở [hướng dẫn hybrid](../../docs/HYBRID_ESP32_11_HOMES.md).

Model nằm trong `main/model_data.h`. Firmware kiểm tra model khi khởi động, chỉ đăng
nhập Wi-Fi/MQTT nếu self-test thành công. Sau mẫu thứ 12, mỗi mẫu mới tạo một dự báo
cho khoảng 5 phút kế tiếp và publish lên `solar/home_01/prediction`.

Firmware này được build bằng **PlatformIO + ESP-IDF** trong VS Code, dùng nguyên
model INT8 và mã ESP-IDF. Không cần chuyển model sang Arduino. Cấu hình khóa
`espressif32@6.13.0` (ESP-IDF 5.5.3) và `espressif/esp-tflite-micro` 1.4.1.
Component TFLite Micro này yêu cầu ESP-IDF 5.1 trở lên.

Trong VS Code:

1. Chọn **File > Open Folder** và mở đúng thư mục `iot_code/firmware/esp32_edge`.
2. Chờ PlatformIO cài platform/framework trong lần build đầu tiên.
3. Bấm **PlatformIO: Build** (dấu tích ở thanh trạng thái).
4. Cắm ESP32, giữ BOOT nếu board yêu cầu, rồi bấm **PlatformIO: Upload**.
5. Mở **PlatformIO: Serial Monitor** ở tốc độ `115200`.

Không mở `iot_code/firmware/blockchain_v2` để build bản AI; đó là firmware Arduino cũ và không
chứa luồng suy luận TFLite Micro. Cấu hình hiện tại đã chứa Wi-Fi và broker của môi
trường demo. Nếu IP máy chạy broker thay đổi, sửa `CONFIG_SOLAR_MQTT_URI` trong
`sdkconfig.esp32dev_ai` trước khi build bằng PlatformIO.

Firmware chỉ kết nối mạng trong `CONFIG_SOLAR_WIFI_SSID` và dùng mật khẩu
`CONFIG_SOLAR_WIFI_PASSWORD`; không còn tự ưu tiên mạng C1 từ danh sách trong code.
Khi đổi Wi-Fi, sửa hai giá trị này trong `sdkconfig.esp32dev_ai` (PlatformIO)
và `sdkconfig` (ESP-IDF), rồi build và upload lại. SSID phải khớp chữ hoa/thường
và khoảng trắng. Cấu hình local đã đồng bộ với mạng đang kết nối và cấu hình Arduino hiện có. Điểm phát Wi-Fi cần hỗ trợ
băng tần 2.4 GHz cho ESP32 này.

Broker ESP32 hiện là `mqtt://192.168.2.5:1885`. Máy tính dùng
`127.0.0.1:1884`. Broker demo không xác thực dùng `mosquitto.conf` ở gốc project;
broker có xác thực dùng `.local/mosquitto-edge.conf`. Listener 1885 của broker
có xác thực yêu cầu tài khoản `solar_edge` và mật khẩu trong
`CONFIG_SOLAR_MQTT_PASSWORD` của `sdkconfig.esp32dev_ai`. Cấu hình local này được
Git ignore vì chứa mật khẩu. Nếu dùng broker có xác thực, phải đặt cả username
và mật khẩu trước khi build; mật khẩu trống sẽ gây `Connection refused, not authorized`.
MQTT Explorer trên cùng máy dùng `mqtt://127.0.0.1:1884`, không nhập username/password
và tắt TLS. Nếu báo `ECONNREFUSED`, khởi động broker:
`& "C:\Program Files\mosquitto\mosquitto.exe" -c ".\.local\mosquitto-edge.conf" -v`
từ thư mục gốc project và giữ terminal đó chạy. Máy tính phải có IP LAN cấu hình
ở listener 1885. Khi chưa kết nối mạng LAN, có thể dùng `.local/mosquitto-viewer.conf`
chỉ mở cổng 1884 nội bộ máy; cấu hình này không nhận dữ liệu ESP32 qua Wi-Fi.
Chỉ chạy một broker trên cổng 1884; dừng broker viewer trước khi chạy broker edge.
PlatformIO dùng `sdkconfig.esp32dev_ai` cho environment này. `sdkconfig.defaults`
và mặc định Kconfig cũng chứa địa chỉ broker để tạo cấu hình mới; thay đổi defaults
không ghi đè giá trị đã có trong sdkconfig. Không sửa `config/sdkconfig.h` sinh ra
trong thư mục build.

Chạy từ thư mục gốc project bằng PowerShell:

```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe"
& $pio run --project-dir "iot_code\firmware\esp32_edge" --environment esp32dev_ai
```

Không cần clean khi tiếp tục build. Build cache nằm tại
`%USERPROFILE%\.platformio\build\solar_edge_ai\esp32dev_ai`. Đường dẫn build không
có khoảng trắng; `CONFIG_COMPILER_HIDE_PATHS_MACROS` được tắt để tránh lỗi
`-fmacro-prefix-map` khi đường dẫn source có khoảng trắng.

Sau khi build báo `SUCCESS`, cắm ESP32 và tự upload:

```powershell
& $pio device list
& $pio run --project-dir "iot_code\firmware\esp32_edge" --environment esp32dev_ai --target upload
& $pio device monitor --project-dir "iot_code\firmware\esp32_edge" --environment esp32dev_ai
```

Nếu máy có nhiều cổng serial, thêm `--upload-port COMx` vào lệnh upload và
`--port COMx` vào lệnh monitor, thay `COMx` bằng cổng USB của ESP32.
Serial Monitor dùng tốc độ `115200`.

Theo dõi telemetry, prediction và actuator trong một terminal khác:

```powershell
& "C:\Program Files\Mosquitto\mosquitto_sub.exe" -h 127.0.0.1 -p 1884 -t "solar/#" -v
```

Chế độ demo mặc định bật, có thể bật lại bằng `demo on`; demo tạo mẫu mỗi 5 giây thực; timestamp mô phỏng tăng 5 phút mỗi mẫu. Prediction
đầu tiên xuất hiện khoảng 55–60 giây sau khi bắt đầu phát mẫu và gom đủ 12 mẫu,
dự báo cho bước mô phỏng 5 phút tiếp theo. Sau khi upload, kiểm tra `SELFTEST PASS`,
MQTT connected và `AI PRED` trên Serial Monitor để xác nhận AI chạy trên board.

Wi-Fi kết nối lại và khởi tạo MQTT chạy trong task `solar_network` với stack
8 KiB. Callback sự kiện Wi-Fi chỉ thông báo cho task này, tránh tràn stack
`sys_evt` khi quét mạng và tránh giữ task sự kiện trong lúc chờ kết nối.

LCD vật lý dùng cấu hình từ `blockchainV2.ino`: LCD 1602 I2C/PCF8574,
địa chỉ `0x27`, SDA GPIO21, SCL GPIO22 (chân mặc định của `Wire.begin()` trên
ESP32 thường). Driver trong `main/lcd_display.cc` dùng I2C của ESP-IDF và chạy
trên task `solar_lcd`; các task telemetry/MQTT chỉ cập nhật mailbox, không chờ
LCD truyền I2C. Thiếu LCD hoặc LCD lỗi không ngăn AI, MQTT và relay hoạt động.

LCD hiển thị cùng giá trị telemetry đã gửi MQTT và in trong log `DEMO sample`:

```text
Ps:3.14 Pl:0.72
N:+2.42kW SELL
```

`Ps` là công suất phát solar, `Pl` là công suất tải, `N` là chênh lệch phát trừ
tải, tất cả dùng **kW**. LCD làm tròn hai chữ số thập phân với dữ liệu demo;
với công suất lớn, giảm độ chính xác để giữ đủ hai giá trị trên một dòng.
SELL/BUY/HOLD trên LCD mô tả cân bằng công suất hiện tại với vùng HOLD ±0.05 kW.
Đề xuất giao dịch của backend dùng dự báo AI và quy tắc riêng; relay tiếp tục
được điều khiển sau settlement. Log `AI PRED` là dự báo cho 5 phút tiếp theo,
nên không cần bằng số đo hiện tại trên LCD.

Sau khi upload, log `LCD 1602 ready: address=0x27 SDA=21 SCL=22` xác nhận driver
đã tìm thấy màn hình. Nếu có `LCD 0x27 unavailable`, kiểm tra lại màn hình,
địa chỉ và chân SDA/SCL; firmware vẫn tiếp tục chạy.

Điều khiển demo qua MQTT, không cần nút nhấn:

```powershell
& "C:\Program Files\mosquitto\mosquitto_pub.exe" -h 127.0.0.1 -p 1884 -t solar/home_01/control -m "demo on"
& "C:\Program Files\mosquitto\mosquitto_pub.exe" -h 127.0.0.1 -p 1884 -t solar/home_01/control -m "demo off"
& "C:\Program Files\mosquitto\mosquitto_pub.exe" -h 127.0.0.1 -p 1884 -t solar/home_01/control -m "demo scenario sell"
& "C:\Program Files\mosquitto\mosquitto_pub.exe" -h 127.0.0.1 -p 1884 -t solar/home_01/control -m "demo scenario buy"
& "C:\Program Files\mosquitto\mosquitto_pub.exe" -h 127.0.0.1 -p 1884 -t solar/home_01/control -m "demo scenario hold"
```

### Đo dòng/áp thật khi `demo off`

`demo off` đọc hai INA219 bằng driver ESP-IDF riêng, với địa chỉ và hiệu chuẩn tương ứng bản Arduino `blockchainV2.ino`. Bản này không include sketch Arduino.
LCD không còn hiển thị `Demo stopped`. `demo on` quay lại mô phỏng; mỗi lần đổi
chế độ tạo `run_id` mới để lịch sử 12 mẫu AI không trộn số đo thật với dữ liệu demo.
Sau khi ESP32 khởi động lại, mặc định là mô phỏng nhanh (`demo_enabled=true`): 5 giây/mẫu, khoảng 60 giây có AI. Dùng `demo off` để đọc INA219 thật với khoảng 5 phút.

| Thiết bị | Địa chỉ I2C | Vai trò |
|---|---|---|
| INA219 nguồn phát | `0x40` | Điện áp, dòng, công suất solar |
| INA219 tải | `0x41` | Điện áp, dòng, công suất tải |
| LCD 1602 / PCF8574 | `0x27` | Hiển thị số đo |

Cả ba dùng chung SDA GPIO21, SCL GPIO22 và GND. Driver dùng một bus I2C của
ESP-IDF, không đưa thư viện Arduino vào firmware. INA219 được hiệu chuẩn giống
Adafruit mặc định: shunt **0.1 Ω**, current LSB 100 µA, power LSB 2 mW.
Đầu đo INA219 chỉ dùng nguồn DC trong giới hạn 0–26 V; không nối điện lưới 220 V.
Nếu board đo dùng shunt khác 0.1 Ω, cần sửa hiệu chuẩn trước khi sử dụng số đo.

Firmware đọc INA219 mỗi **500 ms**. LCD luân phiên ba trang mỗi 3 giây: công suất
`Ps`/`Pl`/`N` bằng **W**, điện áp **V** / dòng **A** của từng kênh và nhiệt độ DS18B20. Trạng thái
SELL/BUY/HOLD trên trang công suất dùng vùng HOLD ±0.05 W như bản Arduino.
Đây là trạng thái cân bằng hiện tại. Khi `demo off`, **relay tải nội bộ GPIO4 bật
(active LOW)** để tải có điện và INA219 0x41 đo được dòng tiêu thụ; **relay P2P
GPIO25 tắt**. Chế độ đo thật bỏ qua lệnh actuator giao dịch. `demo on` tắt hai relay
trước khi quay lại điều khiển theo settlement. Khác với bản Arduino tham chiếu,
việc tắt demo không ngắt nguồn tải nội bộ. Đường cấp tải cần đi qua tiếp điểm
COM–NO của relay GPIO4; `demo status` in trạng thái logic của hai relay trong log.

`solar/home_01/meter` gửi số đo tức thời mỗi **5 giây** khi MQTT kết nối:
`solar_voltage_v`, `solar_current_a`, `solar_power_w`, các trường `load_*`,
`solar_valid`, `load_valid`, `time_synced`. Topic này dùng để đối chiếu LCD/log
`REAL` trên Serial Monitor. Giá trị có thể thay đổi giữa hai lần cập nhật MQTT.
Cảm biến thiếu, mất kết nối hoặc tràn phép đo được đánh dấu `valid=false` và
giá trị JSON `null`; LCD hiện `INA219 error`. Một số đo 0 hợp lệ vẫn có `valid=true`.
Driver thử lại cảm biến sau lỗi; thiếu cảm biến không ngăn demo hoặc AI khởi động.
ACL của broker xác thực phải cho `solar_edge` ghi topic `solar/home_01/meter`.

`solar/home_01/telemetry` dùng **trung bình của khoảng 5 phút thực**, chuyển W
sang kW và tính kWh theo thời gian này; `data_mode=real`, `demo_scenario=none`.
LCD hiển thị tức thời nên có thể khác trung bình trong telemetry. Firmware đồng
bộ thời gian qua SNTP (`pool.ntp.org`) để timestamp khớp mốc 5 phút, múi giờ +07:00.
LCD và topic `meter` vẫn hoạt động khi chưa đồng bộ giờ; lúc đó `timestamp=null`
trên `meter` và chưa gửi telemetry 5 phút. Backend hiện chỉ lưu telemetry/prediction;
topic `meter` xem trực tiếp bằng MQTT Explorer, chưa có bảng số đo tức thời trên web.

Khoảng đầu chưa đủ 5 phút được bỏ qua. Chỉ gửi khoảng hoàn chỉnh có cả hai
cảm biến hợp lệ, dòng/công suất sau lọc không âm, không mất nhịp đọc quá 1.5 giây và không
nhảy đồng hồ. Một kênh lỗi vẫn cho phép xem kênh còn lại trên LCD/`meter`, nhưng
không tạo telemetry AI giả cho khoảng lỗi. Để nhiễu quanh 0 không làm hỏng cả khoảng,
riêng dữ liệu gom mẫu dùng vùng 0 **±0.5 mA** (`kZeroCurrentDeadbandAmps`), với điều kiện
công suất cũng nhỏ (không quá V × 0.5 mA + 2 mW). Dòng/công suất trong vùng này được
coi bằng 0 trước khi lấy trung bình; telemetry ghi `zero_current_deadband_a=0.0005`.
Đây là ngưỡng xử lý, chưa phải hiệu chuẩn offset của cảm biến. Số đo gốc có dấu trên
LCD, log `REAL` và topic `meter` được giữ nguyên. Dòng âm vượt ngưỡng vẫn loại khoảng;
nếu âm ổn định khi có tải, kiểm tra chiều mắc shunt. Tải thật dưới ngưỡng bị coi bằng 0
trong telemetry AI; muốn đo chính xác dòng rất nhỏ cần hiệu chuẩn và chỉnh ngưỡng.
Telemetry đầu tiên thường cần **5–10 phút** sau khi giờ và cảm biến sẵn sàng;
AI cần đủ 12 khoảng liên tiếp, khoảng **60–65 phút** trong chế độ đo thật.

Tương tự bản Arduino, bức xạ/mây được **ước lượng từ công suất** với panel định
mức 3 W (`kPanelRatedWatts`), gắn `weather_source=estimated_from_power`.
DS18B20 nối GPIO27, cấp 3,3 V riêng và kéo DQ lên 3,3 V bằng điện trở 4,7 kΩ.
Driver `espressif/ds18b20` 0.2.0 và 1-Wire RMT chạy ở task `solar_temp` riêng;
thời gian chuyển đổi không chặn chu kỳ INA219/MQTT/AI. Thiếu cảm biến, lỗi CRC hoặc
số đo cũ quá 5 giây được đánh dấu không hợp lệ và thử lại. Topic `meter` có nhiệt
độ tức thời hoặc `null`. Telemetry 5 phút ghi trung bình nhiệt độ hợp lệ, nguồn
`temperature_source=ds18b20`, cờ `temperature_valid` và `temperature_samples`
(số lần lấy snapshot hợp lệ trong chu kỳ đọc 500 ms, không phải số chuyển đổi DS18B20).
Nếu cả khoảng không có nhiệt độ, `temperature_c=0` chỉ là placeholder schema-v1,
kèm `temperature_source=unavailable`, `temperature_valid=false`, số mẫu 0;
backend giữ các cờ này, không diễn giải 0 là nhiệt độ đo được. Một khoảng điện hợp
lệ vẫn được gửi khi nhiệt độ thiếu. Trong demo, nhiệt độ được gắn nguồn `simulation`.
Nhiệt độ chưa là đầu vào của mô hình 53 đặc trưng, nên không đổi artifact INT8. Model INT8 hiện
được huấn luyện với dữ liệu nhà ở cấp kW; việc nhận số đo panel nhỏ cấp W không
đồng nghĩa đã kiểm chứng độ chính xác dự báo. Muốn dự báo sát phần cứng nhỏ cần
thu dữ liệu thật và huấn luyện/hiệu chỉnh model.

Sau khi nạp board và khởi động broker/backend/Hardhat/deployment, chạy:

```powershell
npm.cmd run demo:hardware -- --count 1 --timeout 180
```

Script chờ prediction thật do ESP32 tạo. Nó chỉ đưa proposal lên chain khi prediction
liên kết đúng với telemetry đầu vào, còn mới và không phải HOLD. Relay chỉ được bật
sau khi giao dịch đã settlement thành công và source hash khớp.

Log đúng trên board có thứ tự chính:

```text
SELFTEST PASS ...
MQTT connected; demo telemetry + Edge AI + actuator ready
AI warmup/history 1/12
...
AI PRED target=... solar=... load=... net=... inference=...us
ACTUATOR round=... action=... relay1=... relay2=ON
```


### Kịch bản AI + 11 hộ mô phỏng (05/10/2026)

Trên `/simulation`, chọn **1 ESP32 + 11 hộ mô phỏng**, nguồn **Edge AI từ INA219 thật** khi đo thật hoặc **Edge AI mô phỏng nhanh · 5 giây/mẫu** (mặc định). Cầu nối dùng `solar/home_01/telemetry` và `solar/home_01/prediction` đã lưu ở backend cổng 8000, kiểm tra cùng run/event, đúng model, đúng chế độ nguồn đã chọn, đủ 12 mẫu và thời gian còn hiệu lực. Prediction mới có `data_mode` và `history_samples`; firmware cũ thiếu hai trường này cần nạp lại.

Đo thật cần 12 khoảng 5 phút hoàn chỉnh, khoảng 60–65 phút từ khi khởi động. Nếu mất mẫu, đổi chế độ hoặc mất kết nối MQTT, lịch sử được làm lại. Phiên hybrid chờ tối đa 65 phút mặc định. Không tự chuyển sang persistence khi chưa có AI; muốn dùng Arduino cũ phải chọn **Số đo gần nhất · Arduino**.

Lượng mua/bán = phần nguyên của `abs(predicted_solar_kw - predicted_load_kw) * 1000 / 12` Wh; dưới 1 Wh giữ nguyên. Model INT8 hiện là model tham khảo huấn luyện trên dữ liệu tổng hợp nhà PV 4 kW, chưa được hiệu chuẩn cho bộ pin 3 W. Nối được luồng AI không đồng nghĩa đã kiểm chứng độ chính xác với tải thực nhỏ.

Hybrid ký giao dịch bằng ví thử nghiệm trên máy tính. Công tơ giao điện giữa các hộ vẫn ảo, không gửi actuator cho board. Xem [hướng dẫn hybrid](../../docs/HYBRID_ESP32_11_HOMES.md).


### Tăng tốc 5 giây/mẫu

Theo yêu cầu mô phỏng nhanh, mặc định khi boot là demo bật. `demo on` tạo dữ liệu mô phỏng mỗi 5 giây; timestamp tăng 5 phút/mẫu để giữ hợp đồng feature/model. AI thật sự suy luận trên ESP32; đầu vào và năng lượng vẫn là mô phỏng. Telemetry và prediction ghi `time_mode=accelerated`, `sampling_seconds=5`; giao diện/báo cáo ghi rõ nguồn mô phỏng. 12 mẫu cần khoảng 60 giây, không phải 5 giây cho cả 12 mẫu. `demo off` khôi phục đọc INA219 thật và giữ cửa sổ 12 × 5 phút. Không nén số đo thật thành cửa sổ 1 giờ mà không huấn luyện lại model.
