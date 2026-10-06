# Nạp `blockchainV2.ino` bằng VS Code + PlatformIO

Project này biên dịch trực tiếp file `blockchainV2.ino` ở thư mục gốc. Không cần
sao chép hoặc sửa hai phiên bản code.

## Chuẩn bị

1. Cài extension **PlatformIO IDE** trong VS Code.
2. Cắm board ESP32 bằng cáp USB có truyền dữ liệu.
3. Mở riêng thư mục `iot_code/firmware/blockchain_v2` trong VS Code.
4. Chờ PlatformIO tải ESP32 Arduino framework và các thư viện trong
   `platformio.ini`.

Môi trường mặc định là `esp32dev`, dành cho ESP32 Dev Module dùng chip ESP32
thường. Nếu board là ESP32-S3, ESP32-C3 hoặc model khác, phải đổi `board` và rà
soát lại chân GPIO trước khi nạp.

## Build và nạp

- Nhấn dấu kiểm **Build** trên thanh trạng thái PlatformIO.
- Chọn đúng cổng COM trong PlatformIO nếu máy có nhiều cổng.
- Nhấn mũi tên **Upload**.
- Nếu upload dừng ở `Connecting...`, giữ nút **BOOT**, nhấn **EN/RESET** một
  lần, sau đó thả **BOOT** khi quá trình ghi bắt đầu.
- Mở **Serial Monitor** ở 115200 baud để xem log khởi động.

Board thử lần lượt các SSID và mật khẩu cố định trong `blockchainV2.ino`. Mỗi
mạng có 15 giây để kết nối trước khi chuyển sang mạng dự phòng. ESP32 thường chỉ
hỗ trợ Wi-Fi 2.4 GHz; tên mạng có hậu tố `5G` chỉ hoạt động nếu router cũng phát
SSID đó trên băng tần 2.4 GHz.

## Kết nối phần cứng mà sketch đang dùng

| Thiết bị | Địa chỉ/chân |
|---|---|
| INA219 nguồn phát | I2C `0x40` |
| INA219 tải | I2C `0x41` |
| LCD 16x2 | I2C `0x27` |
| Relay tải nội bộ | GPIO 4, active LOW |
| Relay P2P | GPIO 25, active LOW |
| DS18B20 | GPIO 27 |

Trên ESP32 DevKit thông dụng, I2C mặc định dùng SDA GPIO 21 và SCL GPIO 22.
DHT11 đã được loại khỏi firmware. DS18B20 cung cấp trường `temperature_c` mà
schema backend yêu cầu.

## Luồng dữ liệu tương thích backend/blockchain

Firmware không ghi Firebase. Board tổng hợp số đo theo khoảng 300 giây và gửi MQTT
đến `192.168.2.12:1885`, topic `solar/home_01/telemetry`. Backend đăng ký cùng broker
ở listener cục bộ `127.0.0.1:1884`, kiểm tra schema rồi lưu vào
`data/phase2.sqlite3`. Blockchain bridge đọc telemetry, prediction và proposal qua
API backend; board không ghi trực tiếp vào smart contract.

Mỗi lần ESP32 khởi động tạo một `run_id` 32 ký tự hex. Mỗi bản tin có `event_id`,
timestamp +07:00 đúng biên 5 phút, công suất kW và năng lượng kWh theo schema v1.
DS18B20 được ánh xạ sang `temperature_c`. `irradiance_w_m2` và `cloud_cover` hiện
chỉ là giá trị ước lượng từ công suất tấm pin 3 W, chưa phải số đo bức xạ độc lập.

## DEMO_MODE không cần nút nhấn

Chế độ này chạy được với một ESP32 trần, không cần LCD, INA219, DS18B20, relay hay
ESP32 thứ hai. Firmware tự dò ngoại vi khi khởi động. Nếu không tìm thấy cả hai
INA219 và DS18B20, nó tự bật `DEMO_MODE`; các lỗi thiếu cảm biến chỉ được ghi ra log
và không làm dừng chương trình.

Mở PlatformIO Serial Monitor ở 115200 baud, chọn line ending `Newline`, rồi nhập:

```text
demo on
demo off
demo status
demo scenario auto
demo scenario sell
demo scenario buy
demo scenario hold
```

Trạng thái và kịch bản được lưu trong NVS nên vẫn giữ sau khi reset. Mỗi lần đổi
mode hoặc kịch bản, firmware tạo `run_id` mới để dữ liệu thật và dữ liệu mô phỏng
không nằm chung một run. `demo off` đưa board về đọc INA219/DS18B20 thật.

Sau khi board đã kết nối MQTT, có thể điều khiển từ PowerShell mà không cần cáp USB:

```powershell
& "C:\Program Files\mosquitto\mosquitto_pub.exe" -h 127.0.0.1 -p 1884 -t solar/home_01/control -m "demo on"
& "C:\Program Files\mosquitto\mosquitto_pub.exe" -h 127.0.0.1 -p 1884 -t solar/home_01/control -m "demo scenario sell"
& "C:\Program Files\mosquitto\mosquitto_pub.exe" -h 127.0.0.1 -p 1884 -t solar/home_01/control -m "demo off"
```

Không gửi control message dạng retained để tránh board tự bật lại một lệnh cũ khi
kết nối MQTT lần sau.

Trong `demo scenario auto`, firmware phát 12 mẫu SELL, 12 mẫu BUY và 12 mẫu HOLD,
rồi lặp lại. Một mẫu được gửi mỗi 5 giây nhưng timestamp mô phỏng tiến 5 phút, vì
vậy 12 mẫu đầu tiên có trong khoảng một phút. Giá trị trong từng kịch bản được lấy
ngẫu nhiên trong giới hạn, còn điện áp, dòng điện, công suất và năng lượng được tính
nhất quán. Đây là dữ liệu ở quy mô hộ gia đình để thử phần mềm; không đại diện cho
tấm pin thí nghiệm 3 W.

Telemetry demo có `data_mode=simulation`, `demo_scenario` và bốn trường điện áp/
dòng điện. Backend giữ các trường này trong SQLite và bằng chứng được hash trước khi
đưa lệnh demo lên chain.

Để kiểm tra đầy đủ AI → smart contract → relay trên một board, nạp firmware
`iot_code/firmware/esp32_edge` thay cho sketch Arduino này. Firmware Edge AI tự phát telemetry
demo, gom 12 mẫu, chạy model TFLite Micro INT8 và gửi
`solar/home_01/prediction`. Sau khi broker, backend, Hardhat và deployment đang hoạt
động, chạy tại thư mục gốc:

```powershell
npm.cmd run demo:hardware
```

Lệnh này chỉ nhận proposal có `basis=esp32_forecast`, liên kết ngược được với
prediction TFLite và telemetry mô phỏng. Nó không còn tạo giao dịch từ telemetry
thô. Sau khi contract khớp và source hash được xác minh, backend mới gửi lệnh relay
cho ESP32. Dùng MQTT command `demo scenario sell` hoặc `demo scenario buy` trước khi
chạy để chủ động kiểm thử từng chiều; chờ đủ 12 mẫu (khoảng một phút) cho dự báo đầu
tiên.

Trước khi bật board, chạy broker bằng một trong hai cấu hình tại thư mục gốc:

```powershell
& "C:\Program Files\mosquitto\mosquitto.exe" -c .\.local\mosquitto-edge.conf -v
```

Sau đó chạy backend:

```powershell
.\.venv-backend\Scripts\python.exe -m backend --mqtt-host 127.0.0.1 --mqtt-port 1884
```

Nếu IPv4 Wi-Fi của máy tính thay đổi, cập nhật cả `mqtt_server` trong
`blockchainV2.ino` và dòng `listener 1885` trong cấu hình Mosquitto.
