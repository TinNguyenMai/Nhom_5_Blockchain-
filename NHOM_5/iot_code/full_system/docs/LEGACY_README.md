# P2P Solar Energy Trading — Phase 1–4

**1 ESP32 + 11 hộ mô phỏng:** chọn kịch bản hybrid trên `/simulation`. Mặc định ESP32 chạy Edge AI trên mẫu mô phỏng mỗi 5 giây (~60 giây có AI); có lựa chọn INA219 thật 5 phút/mẫu và Arduino dùng số đo gần nhất. Đối tác và công tơ giao điện là mô phỏng. Xem [hướng dẫn kết nối và kiểm thử](docs/HYBRID_ESP32_11_HOMES.md).

**Đánh giá bằng biểu đồ (05/10/2026):** mặc định chạy 12 phiên cộng đồng với nắng/mây/mưa, tải tăng giảm, giao thiếu và phục hồi uy tín. Biểu đồ thể hiện diễn biến điện phát/tải, cam kết/giao điện, escrow, so sánh uy tín/cọc/giới hạn, phân bổ mua và ma trận giao dịch; chuỗi AI có phóng đại và sai lệch theo thời gian. Lọc theo phiên/hộ, xem bằng chứng và xuất SVG/PNG/CSV. Xem [SIMULATION_EVALUATION.md](SIMULATION_EVALUATION.md).

**Mô phỏng toàn bộ smart contract qua MQTT, không cần phần cứng:** xem [MQTT_MARKET_SIMULATION.md](MQTT_MARKET_SIMULATION.md). Chạy `npm.cmd run dashboard:build` rồi `npm.cmd run simulation:market`; mở http://127.0.0.1:5260/simulation. Mặc định 12 hộ, có thể chọn 6–32 hộ; Token, uy tín, đặt cọc, ưu tiên và xác nhận giao điện chạy trên Hardhat local.

**Cập nhật smart contract 03/10/2026:** xem [SMART_CONTRACT_FEATURES.md](SMART_CONTRACT_FEATURES.md). Khớp lệnh giữ tiền chờ xác nhận giao điện; bổ sung uy tín, đặt cọc và ưu tiên cùng giá. Mô tả thanh toán ngay khi kết toán bên dưới thuộc bản cũ.

**Phase 4 đã bổ sung:** đọc [PHASE4.md](PHASE4.md) để chạy giao diện React, kết nối MetaMask, đặt/hủy lệnh, kết toán SLC và xem receipt local. Chạy `npm.cmd run dashboard:build`, sau đó `npm.cmd run dashboard`; mở http://127.0.0.1:5173. Kết quả kiểm thử: [PHASE4_VALIDATION.md](PHASE4_VALIDATION.md). Với dự án đang chạy Phase 3, dùng gói addon Phase 4 để giữ cấu hình MQTT/firmware/dữ liệu tại máy.

**Phase 3 đã bổ sung:** đọc [PHASE3.md](PHASE3.md) để triển khai token SLC và thị trường điện trên Hardhat, đưa đề xuất Phase 2 lên chain bằng Ethers, và xác minh biên lai. Kết quả kiểm thử: [PHASE3_VALIDATION.md](PHASE3_VALIDATION.md). Gói bổ sung không chứa cấu hình MQTT, firmware hoặc dữ liệu SQLite của bạn.

**Phase 2 đã bổ sung:** xem [PHASE2.md](PHASE2.md) để chạy backend FastAPI, SQLite và đề xuất mua/bán từ ESP32. Mã trong `backend/`, kết quả kiểm thử trong [PHASE2_VALIDATION.md](PHASE2_VALIDATION.md). Khi cập nhật dự án đang dùng, chỉ chép phần backend và tài liệu Phase 2 để giữ cấu hình firmware/MQTT tại máy.

**ESP32 Edge AI: đọc [EDGE_AI.md](EDGE_AI.md)** để nạp board, chạy demo MQTT và xem dự báo Nhà 1. Model INT8 đã huấn luyện sẵn trong `ai_model/artifacts/`; firmware trong `iot_code/firmware/esp32_edge/`. Báo cáo kiểm thử: [EDGE_VALIDATION.md](EDGE_VALIDATION.md). Demo mới dùng `config/edge_demo.json` và lưu số đo/dự báo riêng.

**Hướng dẫn Phase 1B: đọc [PHASE1B.md](PHASE1B.md) trước để chạy bảng điều khiển,
thêm nhà và điều khiển mô phỏng.** Gói mã giữ nguyên MQTT 127.0.0.1:1884 và schema
CSV của Phase 1A. Có thêm `config/homes.json` và `python -m iot_code.panel`.
Phần bên dưới giữ hướng dẫn cơ bản về cài đặt và nguyên lý hoạt động.

Bộ mã khởi đầu: Python Sensor Simulator → MQTT broker → Python Subscriber → CSV.
Hướng dẫn chính dành cho Windows 10/11, PowerShell, Python 3.12 hoặc 3.13.

Trong `final_project_requirements.pdf`, mục 2.1 cho phép cảm biến thực hoặc mô phỏng
gửi dữ liệu qua MQTT/HTTP. Phase 1 này xây dựng phần thu thập dữ liệu. Toàn bộ đồ án
vẫn cần hoàn thiện luồng IoT → AI → Smart Contract ở các phase sau.

## 1. Hiểu các thành phần

| Thành phần | Vai trò |
| --- | --- |
| `iot_code/model.py` | Sinh công suất điện mặt trời, tải tiêu thụ và thời tiết giả lập |
| `iot_code/simulator.py` | Publisher: đóng gói JSON và gửi tới broker |
| Eclipse Mosquitto | Broker: nhận bản tin và chuyển tới client đã đăng ký topic |
| `iot_code/subscriber.py` | Subscriber: nhận, kiểm tra và lưu dữ liệu vào CSV |
| `data/telemetry.csv` | Tự tạo khi chạy subscriber; dữ liệu đầu vào cho bước AI sau này |
| `mosquitto.conf` | Cấu hình broker cục bộ |
| `requirements.txt` | Thư viện Python cần cài |
| `examples/telemetry.json` | Một bản tin đầy đủ theo schema của dự án |
| `tests/test_model.py` | Kiểm tra chu kỳ ngày/đêm, đơn vị, schema và khả năng tái lập |

MQTT là giao thức publish/subscribe. Topic giống tên kênh, không phải địa chỉ ví.
Publisher và subscriber kết nối với broker bằng TCP. Mosquitto chạy trên máy bạn,
độc lập với blockchain. Sau khi cài xong các phần mềm, demo này chạy không cần Internet.

## 2. Cài Python và Mosquitto

1. Nếu đã có Python 3.12/3.13 thì sử dụng bản đang có. Nếu chưa có, vào
   [Python cho Windows](https://www.python.org/downloads/windows/), chọn một bản
   Python 3.13 chính thức với **Windows installer (64-bit)**. Trong trình cài đặt
   truyền thống, bật **Add python.exe to PATH** rồi cài đặt.
2. Đóng và mở lại PowerShell. Chạy:

```powershell
python --version
python -m pip --version
```

3. Vào [Mosquitto Download](https://mosquitto.org/download/), tải bộ cài Windows x64
   và cài đặt. Các lệnh bên dưới giả sử thư mục là `C:\Program Files\mosquitto`.
   Nếu cài nơi khác, thay đường dẫn trong lệnh.
4. Kiểm tra:

```powershell
& "C:\Program Files\mosquitto\mosquitto.exe" -h
```

Nếu `python` báo "Python was not found", Python chưa được cài hoặc PATH đang trỏ tới
shortcut của Microsoft Store. Kiểm tra `where.exe python`; cài Python và bật PATH,
sau đó mở lại terminal. Nếu `py --version` hoạt động, có thể dùng `py -m venv .venv`
ở bước tiếp theo. Chỉ cần một trong hai lệnh khởi tạo môi trường hoạt động.

## 3. Giải nén và cài thư viện dự án

Giải nén bộ mã để có thư mục, ví dụ `C:\Projects\p2p-solar-phase1`.
Trong thư mục này phải thấy `requirements.txt`, `mosquitto.conf` và `iot_code`.
Bạn có thể mở cả thư mục bằng VS Code, hoặc dùng PowerShell trực tiếp.

```powershell
cd C:\Projects\p2p-solar-phase1
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

`.venv` là môi trường Python riêng của đồ án. Các lệnh dùng trực tiếp Python trong
môi trường này, nên không cần chạy `Activate.ps1` hoặc thay execution policy.
Phụ thuộc duy nhất ở Phase 1 là `paho-mqtt==2.1.0`. Mã sử dụng Callback API v2.

## 4. Đọc cấu hình broker

Nội dung chính của `mosquitto.conf`:

```conf
listener 1884 127.0.0.1
allow_anonymous true
persistence false
log_dest stdout
```

- `127.0.0.1`: chỉ nhận kết nối từ chính máy đang chạy broker.
- `1884`: cổng riêng cho đồ án; tránh trùng Mosquitto service có thể đang chạy trên
  cổng mặc định 1883. Cả hai chương trình Python đều mặc định dùng 1884.
- `allow_anonymous true`: demo cục bộ chưa yêu cầu tài khoản.
- `persistence false`: broker không lưu trạng thái xuống đĩa; subscriber lưu CSV.

Cấu hình này dành cho chạy cùng một máy. Khi chuyển sang ESP32 hay máy khác trên
LAN, cần thay cấu hình kết nối và bổ sung xác thực phù hợp.

## 5. Chạy theo thứ tự trong 3 cửa sổ PowerShell

**Cửa sổ 1: chạy broker.** Giữ cửa sổ này mở.

```powershell
cd C:\Projects\p2p-solar-phase1
& "C:\Program Files\mosquitto\mosquitto.exe" -c .\mosquitto.conf -v
```

Kết quả cần có nội dung tương tự `Opening ipv4 listen socket on port 1884`.

**Cửa sổ 2: chạy subscriber trước.**

```powershell
cd C:\Projects\p2p-solar-phase1
.\.venv\Scripts\python.exe -m iot_code.subscriber
```

Chờ xuất hiện `READY solar/+/telemetry`. Đây là xác nhận broker đã chấp nhận
đăng ký topic. Sau đó mới chạy simulator.

**Cửa sổ 3: chạy simulator.**

```powershell
cd C:\Projects\p2p-solar-phase1
.\.venv\Scripts\python.exe -m iot_code.simulator
```

Simulator in `CONNECTED`, rồi `SENT` cho từng hộ. Subscriber in `RECV` và ghi CSV.
Các dòng log dùng chữ không dấu để hiển thị ổn định trên terminal Windows.
Mỗi đợt có 3 bản tin, mỗi hộ một bản tin. Khoảng nghỉ mặc định giữa các đợt là 5 giây.

Muốn dừng: nhấn Ctrl+C ở simulator trước, chờ subscriber nhận hết, rồi Ctrl+C ở
subscriber và broker. CSV được flush sau từng bản tin, không phải chờ lúc thoát.
Chỉ chạy một subscriber ghi vào cùng một đường dẫn CSV.

## 6. Hộ gia đình, topic và dữ liệu

| Hộ | Công suất lắp đặt giả định | Topic |
| --- | ---: | --- |
| `home_01` | 4,0 kW | `solar/home_01/telemetry` |
| `home_02` | 2,5 kW | `solar/home_02/telemetry` |
| `home_03` | 0 kW, chỉ tiêu thụ | `solar/home_03/telemetry` |

Subscriber đăng ký `solar/+/telemetry`; dấu `+` khớp một cấp của topic,
nên nhận được dữ liệu của cả 3 hộ. Mỗi payload là một JSON object.

| Trường | Ý nghĩa |
| --- | --- |
| `schema_version` | Phiên bản cấu trúc bản tin, hiện bằng 1 |
| `event_id` | ID bản tin: `run_id:household_id:sequence` |
| `run_id` | ID riêng mỗi lần chạy simulator; dùng tách các lượt mô phỏng |
| `household_id` | Mã hộ gia đình |
| `timestamp` | Thời điểm bắt đầu khoảng đo giả lập, ISO 8601, UTC+7 |
| `published_at` | Thời điểm thực đóng gói bản tin, UTC; không dùng làm trục thời gian mô phỏng |
| `interval_seconds` | Độ dài khoảng đo giả lập, mặc định 300 giây |
| `irradiance_w_m2` | Bức xạ giả lập, W/m² |
| `temperature_c` | Nhiệt độ giả lập, °C |
| `cloud_cover` | Mây giả lập, từ 0 đến 1 |
| `solar_power_kw` | Công suất phát trung bình xấp xỉ trong khoảng đo, kW |
| `load_power_kw` | Công suất tiêu thụ trung bình xấp xỉ trong khoảng đo, kW |
| `net_power_kw` | Công suất phát trừ công suất tiêu thụ, có thể âm |
| `solar_energy_kwh` | Điện sản xuất trong khoảng đo, kWh |
| `load_energy_kwh` | Điện tiêu thụ trong khoảng đo, kWh |
| `surplus_energy_kwh` | Điện dư trong khoảng đo, không âm |
| `deficit_energy_kwh` | Điện thiếu trong khoảng đo, không âm |

Đọc một bản tin đầy đủ trong `examples/telemetry.json`.

## 7. Công suất, điện năng và hai loại thời gian

`kW` là công suất; `kWh` là điện năng. Trong mã:

```python
energy_kwh = power_kw * interval_seconds / 3600
net_power_kw = solar_power_kw - load_power_kw
surplus_energy_kwh = max(solar_energy_kwh - load_energy_kwh, 0)
deficit_energy_kwh = max(load_energy_kwh - solar_energy_kwh, 0)
```

Ví dụ công suất phát trung bình 3 kW, tiêu thụ 1,2 kW trong 5 phút:
điện phát = 0,25 kWh; điện tiêu thụ = 0,10 kWh; điện dư = 0,15 kWh.
Các trường năng lượng là giá trị riêng mỗi khoảng đo, không phải chỉ số công tơ tích lũy.
Để tính điện năng cả ngày, cộng theo từng hộ và từng `run_id`.

Mặc định, cứ khoảng 5 giây thực, đồng hồ mô phỏng tăng 300 giây.
Do đó 288 khoảng đo tương ứng 24 giờ giả lập, chạy trong khoảng 24 phút thực
cộng thời gian xử lý. Cấu hình mặc định bắt đầu tại `2026-09-01T12:00:00+07:00`;
đây là ngày giả định, không phải ngày đo thực tế.

Khi cần chạy cùng tốc độ thời gian thực, dùng `--interval 5 --step-seconds 5`.
Mỗi lần chạy tạo `run_id` mới; cùng một thời điểm giả lập ở hai lượt chạy là hai
kịch bản khác nhau, không phải một chuỗi đo liên tục.

## 8. Logic mô phỏng

`model.py` sử dụng mô hình đơn giản để kiểm tra luồng dữ liệu:

- Nắng có dạng đường cong sin từ 06:00 đến 18:00, bằng 0 ban đêm.
- Mây biến đổi tương quan theo thời gian và làm giảm bức xạ.
- Công suất phát = công suất lắp đặt × bức xạ/1000 × 0,85.
- Tiêu thụ có nền riêng từng hộ, đỉnh buổi sáng/buổi tối và dao động nhỏ.
- Nhiệt độ thay đổi theo giờ; trong bản đầu này, nó được ghi làm biến thời tiết,
  chưa đưa vào công thức hiệu suất tấm pin.
- Công suất lấy tại giữa khoảng đo để xấp xỉ trung bình; bước đo tối đa 5 phút.
- Không mô phỏng pin lưu trữ, tổn hao đường dây hay chuyển điện vật lý giữa hộ.

Các thông số được chọn cho demo phần mềm, không hiệu chuẩn theo hệ thống điện
thực tế. Dữ liệu phù hợp để thử pipeline và mô hình AI ban đầu; đánh giá AI trên
dữ liệu này không chứng minh khả năng dự báo ngoài thực tế.

## 9. Kiểm tra kết quả

Sau khi dừng simulator, mở PowerShell khác tại thư mục dự án:

```powershell
Import-Csv .\data\telemetry.csv | Select-Object -First 6 household_id,timestamp,solar_power_kw,load_power_kw,net_power_kw
(Import-Csv .\data\telemetry.csv | Measure-Object).Count
```

Demo ngắn có điểm dừng rõ ràng, bắt đầu lúc trưa:

```powershell
.\.venv\Scripts\python.exe -m iot_code.simulator --start "2026-09-01T12:00:00+07:00" --steps 12 --interval 1
```

Lượt này gửi 12 khoảng đo × 3 hộ = 36 bản tin, thêm 36 dòng CSV nếu subscriber
đã `READY` và kết nối liên tục. Nếu CSV đã có dữ liệu, tổng số dòng sẽ lớn hơn 36.
Hộ 1 thường dư điện buổi trưa; hộ 3 luôn có điện phát bằng 0 và thiếu điện.
Để quan sát ban đêm, thay giờ bắt đầu thành `2026-09-01T20:00:00+07:00`.

Chạy kiểm tra mô hình bằng thư viện chuẩn Python:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Phase 1 đạt khi broker chạy, subscriber có `READY`, 3 hộ có dữ liệu, CSV được ghi,
điện phát ban đêm bằng 0, và công thức kW → kWh đúng. Nên lưu ảnh ba terminal và
vài dòng dữ liệu để đưa vào phần thực nghiệm của báo cáo.

## 10. Tạo dữ liệu dài hơn cho AI, sau khi demo đã chạy

Giữ broker hoạt động. Dừng subscriber cũ, khởi động subscriber ghi file riêng:

```powershell
.\.venv\Scripts\python.exe -m iot_code.subscriber --output data\telemetry_30days.csv
```

Chờ `READY`, rồi chạy ở cửa sổ simulator:

```powershell
.\.venv\Scripts\python.exe -m iot_code.simulator --dataset --start "2026-09-01T00:00:00+07:00" --steps 8640 --interval 0 --seed 42 --quiet
```

30 ngày × 288 khoảng/ngày × 3 hộ = **25.920 dòng dữ liệu** nếu file mới và không
mất bản tin. `--interval 0` bỏ khoảng nghỉ, tốc độ thực phụ thuộc máy và MQTT.
Sau `DONE`, chờ subscriber nhận đủ bản tin rồi dừng. Đếm dòng như phần 9.
Muốn một dataset mới, dùng tên CSV chưa có; chương trình mặc định nối thêm dữ liệu.

Khi làm AI sau này, nhóm dữ liệu theo `run_id` và `household_id`, sắp xếp theo
`timestamp`, chia train/test theo thời gian. Đầu ra dự báo nên là sản lượng và tải
của một khoảng tương lai; tránh dùng dữ liệu thời tiết thực đo của tương lai làm
đầu vào nếu thời điểm dự báo chưa biết nó. Phase 1 chưa có mô hình AI.

## 11. MQTT QoS và giới hạn demo

- Publisher và subscriber dùng QoS 1: có thể nhận lặp. Subscriber bỏ bản tin trùng
  theo `event_id`, kể cả sau khi mở lại cùng file CSV.
- Subscriber kiểm tra schema, kiểu số, timestamp, topic và cân bằng năng lượng.
  Dữ liệu sai in `SKIP invalid` và không được ghi CSV.
- `retain=False`: bản tin cũ không được tự gửi lại khi subscriber vừa kết nối.
- Kết nối dùng clean session mặc định. Subscriber tự kết nối lại và đăng ký lại,
  nhưng không nhận bù các bản tin đã gửi khi nó offline. Vì vậy phải khởi động
  subscriber và chờ `READY` trước simulator.
- `SENT` xác nhận broker ACK, không chứng minh CSV đã ghi. Kiểm tra `RECV` và CSV.
- Simulator có chờ kết nối và thời hạn chờ ACK; nếu lỗi quá hạn thì dừng và báo lỗi.
  Chưa có hàng đợi bền vững hay cơ chế tiếp tục chính xác từ khoảng đo cuối cùng.
- ID trong CSV giúp chống ghi lặp ở demo, không phải chữ ký chứng minh nguồn dữ liệu.

## 12. Xử lý lỗi thường gặp

| Hiện tượng | Cách xử lý |
| --- | --- |
| `python` không nhận diện | Kiểm tra cài Python, PATH, mở lại PowerShell; thử `py --version` |
| `No module named paho` | Cài requirements và chạy đúng `.\.venv\Scripts\python.exe` |
| `No module named iot_code` | `cd` vào thư mục có `requirements.txt` trước khi chạy `-m` |
| `Connection refused`, WinError 10061 | Chạy broker trước; kiểm tra cùng host `127.0.0.1` và port `1884` |
| Broker báo port đã được sử dụng | Kiểm tra có cửa sổ broker của đồ án đang chạy không; dùng cửa sổ đó hoặc Ctrl+C để dừng bản cũ |
| Port 1884 do ứng dụng khác dùng | Đổi `listener` sang port trống, ví dụ 1885, rồi thêm `--port 1885` cho cả hai chương trình Python |
| `Not authorized` | Kiểm tra đang dùng đúng file `mosquitto.conf`, đúng cổng; file demo có `allow_anonymous true` |
| Có `SENT`, không có `RECV` | Chờ `READY`, kiểm tra cùng broker/port và topic; bản tin cũ không được phát lại |
| Không mở/ghi được CSV | Đóng CSV trong Excel nếu đang mở; kiểm tra quyền ghi hoặc dùng `--output` đường dẫn mới |
| CSV có nhiều dòng hơn dự kiến | File được nối thêm qua các lượt; dùng `run_id` để tách hoặc chọn filename mới |

## Tài liệu chính thức

- [Python trên Windows](https://docs.python.org/3.13/using/windows.html)
- [Eclipse Mosquitto Download](https://mosquitto.org/download/)
- [Cấu hình Mosquitto](https://mosquitto.org/man/mosquitto-conf-5.html)
- [Eclipse Paho Python](https://eclipse.dev/paho/clients/python/)
- [Callback API và MQTT client](https://eclipse.dev/paho/clients/python/docs/)
- [paho-mqtt 2.1.0](https://pypi.org/project/paho-mqtt/2.1.0/)
