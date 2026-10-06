# Hướng dẫn chạy lại bản 1 ESP32 + 11 hộ mô phỏng

Dùng cho các lần chạy sau, khi firmware đã được nạp vào board. Mọi lệnh chạy trong PowerShell **tại thư mục gốc của dự án** (thư mục chứa `package.json`). Mỗi dịch vụ ở bước 2 chạy trong một cửa sổ riêng và phải để cửa sổ đó mở.

Hướng dẫn này viết cho máy đã cài đặt xong. Trên máy mới, làm theo README trước: cài phụ thuộc, tạo `.local/mosquitto-edge.conf` bằng `scripts/setup_edge_broker.ps1`, điền Wi-Fi/MQTT và nạp firmware. Nếu môi trường Python của bạn tên khác `.venv-runtime` (README dùng `.venv-backend`), thay tên đó trong các lệnh bên dưới.

## 1. Trước khi chạy: kiểm tra mạng

ESP32 và máy tính phải ở cùng một mạng Wi-Fi 2,4 GHz (mạng đã ghi trong firmware). Địa chỉ IP của máy tính phải đúng với địa chỉ đã ghi ở hai nơi:

| Nơi ghi | Dòng |
|---|---|
| `iot_code/firmware/esp32_edge/sdkconfig.esp32dev_ai` | `CONFIG_SOLAR_MQTT_URI="mqtt://<IP>:1885"` |
| `.local/mosquitto-edge.conf` | `listener 1885 <IP>` |

Xem IP hiện tại của máy tính:

```powershell
Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi' | Select-Object IPAddress
```

Nếu IP khác với hai dòng trên (điểm phát Wi-Fi của điện thoại thường đổi IP sau mỗi lần bật lại), sửa cả hai dòng rồi nạp lại firmware theo mục 6. Nếu IP không đổi thì không cần nạp lại.

## 2. Khởi động ba dịch vụ

**Cửa sổ 1 — broker MQTT**

```powershell
& "C:\Program Files\mosquitto\mosquitto.exe" -c .local\mosquitto-edge.conf -v
```

**Cửa sổ 2 — backend** (chờ dòng `READY backend MQTT 127.0.0.1:1884`)

```powershell
.\.venv-runtime\Scripts\python.exe -m backend --mqtt-host 127.0.0.1 --mqtt-port 1884 --port 8000 --stale-seconds 360
```

**Cửa sổ 3 — giao diện mô phỏng** (chờ dòng `MQTT MARKET SIMULATION: http://127.0.0.1:5260/simulation`)

```powershell
npm.cmd run simulation:hybrid -- --python .venv-runtime/Scripts/python.exe
```

## 3. Cấp nguồn cho ESP32

Cắm board vào nguồn. Không cần nạp lại và không cần gửi lệnh: board tự vào chế độ đo cảm biến thật, 5 giây một mẫu, và tự kết nối lại nếu broker khởi động sau.

Xem log của board (tùy chọn; thoát bằng `Ctrl+C`):

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" device monitor --project-dir "iot_code\firmware\esp32_edge" --environment esp32dev_ai
```

Log đúng theo thứ tự:

```text
SELFTEST PASS model=home01-next5m-int8-...
Wi-Fi ready
MQTT connected; ...
SOURCE=ina219/5s run_id=...; new AI history
REAL 5s sample=0 reads=10 solar=...W load=...W queued=...
AI warmup/history 1/12
AI PRED target=... solar=... load=... net=... inference=...us
```

Dòng `AI PRED` đầu tiên xuất hiện sau khoảng 60 giây.

## 4. Chạy kịch bản

Hỏi cầu nối xem đã nhận được dự báo từ board chưa:

```powershell
Invoke-RestMethod "http://127.0.0.1:5260/simulation/hardware?source=ai-live"
```

Khi `ready` là `True`:

1. Mở `http://127.0.0.1:5260/simulation`.
2. Kịch bản: **1 ESP32 + 11 hộ mô phỏng**.
3. Nguồn lệnh Nhà 1: **Edge AI từ INA219 thật · 5 giây/mẫu** (mặc định).
4. Bấm **Chạy 1 ESP32 + 11 hộ**.

Lượt chạy mất khoảng 30 giây. Thành công khi trạng thái là **Đã hoàn tất**, có 12 hộ, kịch bản đạt 1/1 và bảo toàn Token ghi **Đúng**.

## 5. Lấy bằng chứng cho báo cáo

| Bằng chứng | Nơi lấy |
|---|---|
| Số đo và dự báo board gửi | `mosquitto_sub -h 127.0.0.1 -p 1884 -t "solar/home_01/#" -v`, hoặc MQTT Explorer nối `127.0.0.1:1884` |
| Log board: self-test, số đo, thời gian suy luận | Serial Monitor ở mục 3 |
| Kết quả lượt chạy | `data/market-simulation/<run_id>/report.json`: `scenario=hybrid`, `passed=true`, `data_kind=hybrid_accelerated_measurement` |
| Số đo và dự báo dùng để đặt lệnh | `data/market-simulation/<run_id>/esp32-source.json` |
| Giao dịch trên blockchain local | Mục **Biên lai blockchain** trên giao diện, hoặc `transactions.json` |
| Báo cáo đầy đủ | Nút **Tải báo cáo JSON** trên giao diện |

Khi viết báo cáo, ghi đúng phạm vi:

- Số đo là thật, lấy từ INA219, trung bình 5 giây. AI chạy thật trên ESP32.
- Mỗi mẫu 5 giây được model coi là một bước 5 phút. `timestamp` trong bản tin là thời gian logic; lượng Wh của lệnh là giá trị quy đổi theo bước 5 phút.
- Lượng mua/bán của Nhà 1 lấy từ **dự báo** của model, không phải từ số đo. Model huấn luyện trên dữ liệu tổng hợp của nhà có PV 4 kW, nên với mạch thí nghiệm cỡ dưới 1 W, dự báo lệch rất xa số đo (ví dụ đo tải 0,0003 kW, dự báo 0,18 kW). Đây là giới hạn đã biết của model, không phải kết quả về độ chính xác.
- 11 hộ còn lại, công tơ giao điện và ví là mô phỏng; chưa xác minh truyền điện vật lý.

## 6. Khi cần nạp lại firmware

Chỉ cần khi đổi Wi-Fi, đổi IP máy tính hoặc sửa mã. Đóng Serial Monitor trước khi nạp.

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run --project-dir "iot_code\firmware\esp32_edge" --environment esp32dev_ai --target upload
```

Nếu kẹt ở `Connecting...`: giữ nút BOOT, nhấn EN/RESET một lần, thả BOOT khi bắt đầu ghi. Sau khi đổi `sdkconfig.esp32dev_ai`, lần build đầu mất 5–10 phút vì biên dịch lại toàn bộ.

## 7. Lệnh điều khiển board

Gửi tới topic `solar/home_01/control`, không đặt cờ retain:

```powershell
& "C:\Program Files\mosquitto\mosquitto_pub.exe" -h 127.0.0.1 -p 1884 -t solar/home_01/control -m "demo status"
```

| Lệnh | Tác dụng | Nguồn tương ứng trên giao diện |
|---|---|---|
| `real fast` | Đo thật, 5 giây/mẫu (mặc định khi bật nguồn) | Edge AI từ INA219 thật · 5 giây/mẫu |
| `real slow` | Đo thật, trung bình 5 phút; dự báo đầu tiên sau 60–65 phút | Edge AI từ INA219 thật · 5 phút/mẫu |
| `demo on` | Board tự sinh mẫu mô phỏng mỗi 5 giây | Edge AI mô phỏng nhanh · 5 giây/mẫu |
| `demo off` | Quay về đo thật | — |
| `demo status` | In trạng thái ra Serial Monitor | — |

Lựa chọn không được lưu: sau khi reset, board quay về `real fast`.

## 8. Xử lý sự cố

| Hiện tượng | Nguyên nhân và cách xử lý |
|---|---|
| Board báo `MQTT transport error` lặp lại | Máy tính không còn giữ IP ghi trong firmware, hoặc broker chưa chạy. Làm lại mục 1 và cửa sổ 1 |
| `ECONNREFUSED 127.0.0.1:1884` trên MQTT Explorer | Broker chưa chạy. Chạy cửa sổ 1 |
| `[Errno 10048]` khi chạy backend, hoặc cổng 5260 bận | Bản cũ còn chạy ngầm. Dừng bằng lệnh bên dưới rồi chạy lại |
| Trang `127.0.0.1:5260` không mở được | Giao diện mô phỏng chưa chạy. Chạy cửa sổ 3 |
| `ready: False`, "chờ đủ 12 mẫu" | Chờ thêm khoảng 60 giây sau khi board kết nối |
| `ready: False`, "Số đo ESP32 đã cũ" | Board không gửi dữ liệu. Xem Serial Monitor và kiểm tra broker |
| `ready: False`, "Bản tin Nhà 1 gần nhất là demo" | Board đang ở `demo on`. Gửi `demo off` hoặc chọn nguồn mô phỏng |
| Log có `REAL 5s window discarded` liên tục | Một trong hai INA219 lỗi hoặc mất kết nối. Kiểm tra dây SDA/SCL (GPIO21/22) và địa chỉ `0x40`, `0x41` |
| Backend log có `REJECT` | Board chạy firmware cũ hơn backend. Nạp lại firmware theo mục 6 |

Dừng các tiến trình cũ còn giữ cổng 8000 và 5260:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8000,5260 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Dừng broker cũ còn chạy ngầm:

```powershell
Get-CimInstance Win32_Process -Filter "Name='mosquitto.exe'" | Where-Object { $_.CommandLine -like '*mosquitto-edge.conf*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
