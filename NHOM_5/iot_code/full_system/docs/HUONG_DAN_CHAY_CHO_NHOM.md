# Hướng dẫn chạy P2P Solar cho thành viên nhóm

Gói này gồm hai demo riêng: **12 hộ trên máy tính** và **một ESP32 đại diện home_01 có đủ INA219, DS18B20, LCD, relay và AI INT8**. Có thể chạy demo ESP32 với board trần bằng số đo giả, hoặc bật đọc cảm biến thật. Chế độ kết hợp 11 hộ giả lập + 1 board chưa được hiện thực.

## 1. Giải nén và nhận diện mã

Giải nén ZIP vào đường dẫn ngắn, ví dụ `C:\solar-lab\p2p-solar-team`. Mở PowerShell tại thư mục chứa `package.json` và hướng dẫn này. Các lệnh bên dưới đều chạy từ thư mục đó, trừ khi ghi khác.

```text
p2p-solar-team/
├── HUONG_DAN_CHAY.md          # Tài liệu này
├── README.md
├── iot_code/                 # Simulator Python và client MQTT các hộ
├── firmware/
│   ├── esp32_edge/            # Firmware chính: cảm biến + INT8, ESP-IDF
│   └── blockchain_v2/         # Arduino tham chiếu/dự phòng, không có AI INT8
├── blockchainV2.ino          # Sketch được bản Arduino include trực tiếp
├── ai_model/                 # Pipeline tùy chọn, trọng số và metadata có sẵn
├── contracts/                # SolarToken và EnergyMarket
├── blockchain/               # Gateway, Ethers, triển khai và demo
├── backend/                  # FastAPI/SQLite, tiếp nhận dữ liệu ESP32
├── dashboard/                # Giao diện React
├── config/                   # Hồ sơ 12 hộ và cấu hình nhánh ESP32
├── scripts/                  # Thiết lập broker và firmware trên máy của bạn
├── tests/                    # Kiểm tra phần mềm/firmware logic
└── docs/                     # Minh chứng kiểm tra và manifest gói
```

Giữ các đường dẫn này. Đặc biệt, không chuyển `blockchainV2.ino` đi nơi khác vì `iot_code/firmware/blockchain_v2/src/main.cpp` include nó bằng đường dẫn tương đối.

## 2. Cài môi trường lần đầu

- Windows 10/11, PowerShell; Node.js >=22.13 theo `package.json`, có npm.
- Python 3.12, có Python Launcher `py`.
- Mosquitto, mặc định `C:\Program Files\mosquitto` (cần các công cụ `mosquitto.exe`, `mosquitto_sub.exe`, `mosquitto_pub.exe`, `mosquitto_passwd.exe`).
- Khi nạp board: VS Code + extension PlatformIO IDE, cáp USB dữ liệu và driver USB-UART phù hợp board.

```powershell
node --version
npm.cmd --version
py -3.12 --version
npm.cmd ci
py -3.12 -m venv .venv-backend
.\.venv-backend\Scripts\python.exe -m pip install -r backend/requirements.txt
npm.cmd run dashboard:build
```

Nếu không có lệnh `py`, thay `py -3.12` bằng đường dẫn Python 3.12 của máy bạn. Không sao chép venv từ máy người khác. Không cần activate venv hoặc đổi execution policy toàn máy. Không cần TensorFlow để chạy hai demo: model INT8 đã nằm trong firmware.

Nếu Mosquitto cài khác chỗ, thiết lập trong terminal chạy demo:

```powershell
$env:SOLAR_MOSQUITTO_BIN = 'D:/Tools/mosquitto/mosquitto.exe'
```

Internet cần cho bước cài thư viện và build firmware lần đầu; broker/chain/demo chạy local. Chế độ đọc thật dùng SNTP nên cần truy cập máy chủ thời gian để phát telemetry 5 phút.

## 3. Demo 12 hộ: không cần phần cứng

```powershell
npm.cmd run simulation:market -- --homes 12 --scenario full-demo
```

Mở `http://127.0.0.1:5260/simulation`. Chương trình tự chạy broker MQTT, Hardhat node, triển khai contract, tạo 12 ví và 12 client hộ. **Không phải tự chạy broker, backend hoặc npm run chain cho chế độ này.**

Kết quả mong đợi: `full-demo` đạt 22/22 kiểm tra, token được bảo toàn, escrow cuối kịch bản bằng 0. Dashboard cho xem hộ, số dư, uy tín, cọc, ưu tiên, lệnh, hash/receipt và tải JSON báo cáo. Dữ liệu phiên mới nằm trong `data/market-simulation/<run_id>/`.

Giữ terminal mở để xem dashboard hoặc chạy lượt mới. Nhấn `Ctrl+C` để dừng các tài nguyên do lượt chạy tạo. Chạy đơn giản/terminal hoặc đổi cổng web:

```powershell
npm.cmd run simulation:market -- --homes 12 --scenario basic
npm.cmd run simulation:market -- --homes 12 --scenario full-demo --no-dashboard
npm.cmd run simulation:market -- --homes 12 --ui-port 5261
```

Nếu venv nằm chỗ khác:

```powershell
npm.cmd run simulation:market -- --homes 12 --python 'D:/venvs/solar/Scripts/python.exe'
```

Các hộ ảo dùng persistence-style forecast, không chạy INT8 cho cả 12 hộ. Cảm biến và lượng giao nhận của demo này đều là mô phỏng. Các kịch bản biên có số lượng cố định để kiểm tra hợp đồng, không đại diện công suất hộ thực.

## 4. Phần cứng của một hộ

Firmware chính là **iot_code/firmware/esp32_edge**, environment **esp32dev_ai**, chip ESP32 thường, flash 4 MB. Không chọn ESP32-S3/C3 nếu chưa đổi board và kiểm tra chân.

Partition ứng dụng là 1500 KiB theo ESP-IDF `partitions_singleapp_large.csv`; giới hạn build PlatformIO đã được đặt tương ứng. Dung lượng RAM hiển thị khi build là bộ nhớ tĩnh, không thay cho đo heap/stack thực trên board.

| Thiết bị | Chân/địa chỉ | Ghi chú |
|---|---|---|
| INA219 nguồn phát | I²C 0x40 | Shunt 0,1 Ω, đọc áp/dòng/công suất DC |
| INA219 tải | I²C 0x41 | Cấu hình địa chỉ khác 0x40 trên module |
| LCD 1602/PCF8574 | I²C 0x27 | Hiển thị công suất, điện và nhiệt độ |
| I²C dùng chung | SDA GPIO21; SCL GPIO22 | Chung GND; mức logic bus phù hợp ESP32 3,3 V |
| DS18B20 | DQ GPIO27 | VDD 3,3 V, GND chung, DQ kéo lên 3,3 V qua 4,7 kΩ; dùng cấp nguồn 3 dây |
| Relay tải nội bộ | GPIO4, active LOW | Đường tải qua COM–NO; demo off bật tải nội bộ |
| Relay P2P | GPIO25, active LOW | Chỉ bật trong demo sau lệnh settlement; demo off giữ tắt |

INA219 của mô hình này chỉ đo DC trong giới hạn của module (bus tối đa 26 V), **không nối trực tiếp điện lưới 220 V**. Nếu LCD/module kéo SDA/SCL lên 5 V, dùng chuyển mức hoặc chỉnh nguồn/pull-up phù hợp trước khi nối ESP32. Relay cần module/driver phù hợp; không cấp cuộn relay trực tiếp từ GPIO. Khi dùng DS18B20 dạng dây bọc, kiểm tra pinout của đúng sản phẩm.

Thông số cảm biến tham khảo [datasheet DS18B20 của Analog Devices](https://www.analog.com/media/en/technical-documentation/data-sheets/ds18b20.pdf) và [datasheet INA219 của TI](https://www.ti.com/lit/ds/symlink/ina219.pdf). Các chân GPIO trong bảng là lựa chọn của firmware dự án.

Không có ngoại vi vẫn chạy được chế độ demo trên một ESP32 trần. DS18B20 lỗi/thiếu không ngăn AI hay MQTT; INA219 thiếu chỉ ngăn telemetry điện thật hợp lệ.

## 5. Thiết lập broker LAN và cấu hình ESP32

Máy tính và ESP32 phải cùng mạng Wi-Fi/LAN, Wi-Fi board dùng 2,4 GHz. Xem IPv4 của adapter đang dùng:

```powershell
ipconfig
```

Ví dụ máy bạn có IP `192.168.1.10`; thay IP này bằng IP thật trong các lệnh tiếp theo. Không dùng 127.0.0.1 trên board.

Tạo broker có hai listener: máy tính dùng `127.0.0.1:1884`; board dùng `IP_LAN:1885`, tài khoản `solar_edge`. Script hỏi mật khẩu và tạo các file riêng của máy trong `.local/`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup_edge_broker.ps1 -LanIp 192.168.1.10
```

Nếu Mosquitto cài ở thư mục khác, thêm `-MosquittoDirectory 'D:\Tools\mosquitto'`. Nếu `.local` đã tồn tại, tái sử dụng file và cập nhật IP listener trong `.local/mosquitto-edge.conf`; script không ghi đè mật khẩu hiện có.

Cấu hình Wi-Fi và MQTT cho firmware bằng mẫu đã kèm. Dùng đúng mật khẩu MQTT vừa tạo; Wi-Fi password và MQTT password được hỏi bằng nhập ẩn:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure_team_esp32.ps1 -LanIp 192.168.1.10
```

Script tạo `iot_code/firmware/esp32_edge/sdkconfig.esp32dev_ai` và `sdkconfig`. Đây là các file cá nhân; không gửi chúng lại vào nhóm/repository. `sdkconfig.team.example` và `sdkconfig.defaults` trong gói không chứa mật khẩu thật. Khi IP/Wi-Fi đổi, chạy lại script cấu hình và build/nạp lại.

Mở terminal số 1 chạy broker, giữ cửa sổ này hoạt động:

```powershell
& 'C:\Program Files\mosquitto\mosquitto.exe' -c '.\.local\mosquitto-edge.conf' -v
```

Cho phép kết nối Mosquitto TCP1885 trên mạng Private nếu Windows Firewall chặn. Không mở listener này ra Internet. MQTT Explorer trên chính máy broker dùng `127.0.0.1:1884`, không xác thực, không TLS.

## 6. Build, nạp và xem log ESP32

Trong VS Code mở riêng `iot_code/firmware/esp32_edge`, chọn PlatformIO environment `esp32dev_ai`, bấm Build, Upload rồi Monitor. Lần đầu PlatformIO tải platform/framework và component chính thức (TFLite Micro, DS18B20/1-Wire).

Build đầu tiên có thể mất nhiều phút vì phải biên dịch ESP-IDF và TFLite Micro; chờ dòng `SUCCESS` trước khi Upload. Các lần sau tận dụng cache. Khi kiểm tra demo 12 hộ trên máy ít RAM, nên đợi build firmware xong để giảm tải đồng thời.

Từ PowerShell ở gốc gói có thể dùng:

```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe"
& $pio run --project-dir iot_code/firmware/esp32_edge --environment esp32dev_ai
& $pio device list
& $pio run --project-dir iot_code/firmware/esp32_edge --environment esp32dev_ai --target upload --upload-port COM5
& $pio device monitor --project-dir iot_code/firmware/esp32_edge --environment esp32dev_ai --port COM5
```

Thay `COM5` bằng cổng board. Serial Monitor là 115200 baud; một số board cần giữ BOOT khi upload Connecting. Trong firmware Edge AI, điều khiển demo bằng MQTT, không phải gõ lệnh vào serial.

Log cần có `SELFTEST PASS`, `MQTT connected`; sau khoảng 12 mẫu, có `AI PRED`. Nếu nối cảm biến, có `DS18B20 ready: GPIO27 ...`, `INA219 ready` và `LCD 1602 ready`. Missing sensor được báo riêng.

## 7. Demo ESP32: AI → backend → smart contract → relay

Sau khi broker ở mục 5 đang chạy và board được nạp, mở các terminal ở gốc gói:

**Terminal số 2 – backend:**

```powershell
.\.venv-backend\Scripts\python.exe -m backend --mqtt-host 127.0.0.1 --mqtt-port 1884
```

API tại `http://127.0.0.1:8000`; giao diện theo dõi backend tại `/`. Broker và backend phải chạy trước khi lấy prediction cho demo.

**Terminal số 3 – Hardhat local:**

```powershell
npm.cmd run compile
npm.cmd run chain
```

**Terminal số 4 – triển khai contract:**

```powershell
npm.cmd run deploy
```

**Terminal số 5 – chọn kịch bản SELL, chờ đủ lịch sử rồi chạy giao dịch:**

```powershell
& 'C:\Program Files\mosquitto\mosquitto_pub.exe' -h 127.0.0.1 -p 1884 -t solar/home_01/control -m 'demo on'
& 'C:\Program Files\mosquitto\mosquitto_pub.exe' -h 127.0.0.1 -p 1884 -t solar/home_01/control -m 'demo scenario sell'
npm.cmd run demo:hardware -- --count 1 --timeout 180
npm.cmd run market:report
```

Prediction đầu tiên thường sau khoảng 55–60 giây: mẫu phát mỗi 5 giây thực nhưng timestamp mô phỏng tăng 5 phút. Chọn `demo scenario buy` để thử BUY; mỗi lần đổi chế độ/kịch bản tạo run mới và cần gom lại 12 mẫu. HOLD có thể không tạo giao dịch.

Kết quả cần đối chiếu: `AI PRED` trên board; backend có telemetry/prediction/proposal; script báo `HARDWARE AI CONFIRMED`; board báo `ACTUATOR`; có receipt local và acknowledgement đúng relay. Sau khoảng 15 giây relay demo tự hết hạn. Script chỉ nhận prediction ESP32 có liên kết dữ liệu, không lấy telemetry thô hoặc số đo thật để tự giao dịch.

Muốn xem dashboard Web3 nhánh này, chạy `npm.cmd run dashboard` ở terminal khác rồi mở `http://127.0.0.1:5173`. MetaMask chỉ cần cho thao tác ví thủ công; không bắt buộc cho script demo:hardware. Dashboard mô phỏng 12 hộ là cổng 5260, không trộn dữ liệu hai nhánh.

Theo dõi tất cả topic (không gửi control retained):

```powershell
& 'C:\Program Files\mosquitto\mosquitto_sub.exe' -h 127.0.0.1 -p 1884 -t 'solar/#' -v
```

## 8. Đọc cảm biến thật bằng firmware chính

```powershell
& 'C:\Program Files\mosquitto\mosquitto_pub.exe' -h 127.0.0.1 -p 1884 -t solar/home_01/control -m 'demo off'
```

- INA219 đọc mỗi 500 ms. DS18B20 dùng task riêng, khoảng 2 giây có kết quả; snapshot cũ quá 5 giây bị loại.
- LCD luân phiên ba trang mỗi 3 giây: công suất W, điện áp/dòng, nhiệt độ °C.
- Topic `solar/home_01/meter` gửi số đo tức thời mỗi 5 giây, có nhiệt độ hoặc `null`, cờ `temperature_valid` và nguồn `ds18b20`/`unavailable`. Xem topic này bằng MQTT Explorer; backend chưa có bảng meter tức thời riêng.
- Telemetry gửi trung bình khoảng 5 phút thật, đúng mốc thời gian +07:00 sau SNTP. Khoảng điện thiếu mẫu/lỗi bị bỏ; thiếu nhiệt độ không bỏ khoảng điện hợp lệ.
- `temperature_samples` là số lần lấy snapshot nhiệt độ hợp lệ ở vòng 500 ms, không phải số lần DS18B20 chuyển đổi. Nếu có một phần mẫu hợp lệ, giá trị là trung bình các mẫu đó. Nếu không có mẫu, telemetry giữ số 0 để tương thích schema-v1, đồng thời `temperature_valid=false`, `temperature_source=unavailable`, `temperature_samples=0`; 0 này không được xem là nhiệt độ đo.
- Khoảng telemetry đầu tiên thường sau 5–10 phút; AI cần 12 khoảng liên tiếp, khoảng 60–65 phút. Nhiệt độ hiện không thuộc 53 đầu vào AI. Model được huấn luyện bằng dữ liệu cấp kW, chưa kiểm chứng độ chính xác trên panel thí nghiệm 3 W; bức xạ/mây vẫn ước lượng từ công suất.
- `demo off` bật relay tải nội bộ GPIO4 và tắt relay P2P GPIO25; lệnh giao dịch actuator bị bỏ qua. `demo:hardware` chỉ chấp nhận chế độ mô phỏng. Bật lại `demo on` để thử luồng giao dịch/relay.

## 9. Bản Arduino dự phòng

Mở `iot_code/firmware/blockchain_v2` trong PlatformIO, environment `esp32dev`. Bản này biên dịch `blockchainV2.ino` ở gốc, có INA219/LCD/DS18B20/relay nhưng không chạy INT8. Trước khi build, sửa các placeholder `wifi_ssids`, `wifi_passwords`, `mqtt_server`, `mqtt_password` trong sketch để khớp broker đã thiết lập. Dùng Serial Monitor 115200, Newline để nhập `demo on`, `demo off`, `demo status`, `demo scenario sell|buy|hold|auto`. Các chế độ của bản Arduino có hành vi relay riêng; tham khảo code và thử với tải DC mô hình.

Để chạy script `demo:hardware` có AI và kiểm tra acknowledgement, nạp firmware chính `esp32_edge`.

## 10. Các lỗi thường gặp

| Lỗi | Cách xử lý |
|---|---|
| `py` không có | Cài Python 3.12 có Launcher hoặc dùng đường dẫn Python thật. |
| Venv không chạy sau chuyển máy | Xóa/tạo lại venv trên máy bạn; không dùng venv sao chép. |
| `Mosquitto not found` | Cài Mosquitto hoặc đặt `SOLAR_MOSQUITTO_BIN`. |
| MQTT `Connection refused/not authorized` | Broker chưa chạy, sai listener/IP hoặc sai username/password; máy và board cùng LAN. |
| Wi-Fi không kết nối | Kiểm tra SSID/password, băng 2,4 GHz và cấu hình đã build/nạp đúng. |
| LCD không hiện | Kiểm tra 0x27, SDA21/SCL22, GND, nguồn, biến trở contrast và mức logic. |
| DS18B20 unavailable | Kiểm tra GPIO27, GND/VDD, pull-up 4,7 kΩ và cấp nguồn 3 dây; xem log CRC/presence. |
| INA219 lỗi/âm | Kiểm tra 0x40/0x41, dây bus, shunt/chiều mắc; 0 hợp lệ khác cảm biến thiếu. |
| Không có prediction | Demo chờ 12 mẫu; đo thật chờ 12 khoảng liên tiếp có SNTP và số đo điện hợp lệ. |
| `HARDWARE WAIT` | Backend/broker/board phải đang chạy; chọn SELL/BUY, dùng firmware AI và demo on; chờ prediction mới. |
| Node đã restart | Chạy lại `npm.cmd run deploy`; deployment cũ không còn khớp chain. |
| Cổng web bận | Demo 12 hộ thêm `--ui-port 5261`; dừng đúng terminal của nhánh đang chạy. |
| PlatformIO lỗi đường dẫn | Giải nén đường dẫn ngắn; không mang theo build cache/.vscode của máy cũ. |

## 11. Kiểm tra phần mềm và thông tin bàn giao

Sau cài dependency, có thể chạy `npm.cmd run test:simulation` và `npm.cmd test`. Test firmware trên host cần GCC/G++ và ESP-IDF cJSON; không bắt buộc để chạy demo. Kết quả kiểm tra lần đóng gói nằm ở `docs/TEAM_VALIDATION.md`; danh sách file/hash trong `docs/TEAM_MANIFEST.json`.

Token SLC, ví Hardhat và chain đều là thử nghiệm local. Hai demo không giao điện thật có xác minh ngoài mô hình; công tơ ảo không phải công tơ thương mại. Gói không chứa cấu hình/mật khẩu Wi-Fi của máy tác giả. Sau khi tự cấu hình, không gửi `.local`, `sdkconfig*` cá nhân, venv, node_modules, build cache hay dữ liệu runtime cho người khác.

Nguồn driver DS18B20: [Espressif Component Registry, v0.2.0](https://components.espressif.com/components/espressif/ds18b20/versions/0.2.0/examples/ds18b20_read?language=en). Firmware dùng driver ESP-IDF và RMT, không cần đưa thư viện Arduino vào nhánh AI.
