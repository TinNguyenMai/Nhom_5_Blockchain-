# Hệ thống CPS giao dịch năng lượng mặt trời P2P

Đồ án tích hợp IoT, AI và Blockchain. Bộ mã có mô phỏng nhiều hộ qua MQTT, mô hình AI hồi quy đã huấn luyện và firmware ESP32. Smart contract quản lý Token, escrow, khớp lệnh, uy tín, đặt cọc và ưu tiên người mua.

## 1. Cấu trúc nộp bài

```text
<thư mục nộp>/
├── README.md        # File này: cài đặt, cấu hình và chạy demo
├── contracts/       # Smart contract Solidity: SolarToken.sol, EnergyMarket.sol
├── ai_model/        # Mã huấn luyện, đánh giá, suy luận
│   └── artifacts/   # Trọng số: model.keras, model_fp32.tflite, model_int8.tflite
└── iot_code/        # Mã IoT
    ├── *.py                  # Simulator Python, MQTT, công tơ ảo
    ├── blockchainV2.ino      # Sketch Arduino mẫu (không có AI)
    ├── firmware/esp32_edge/  # Firmware nạp ESP32: cảm biến + Edge AI + MQTT
    └── full_system/          # Toàn bộ hệ thống để chạy demo
```

`contracts`, `ai_model` và `iot_code` là ba thành phần theo yêu cầu học phần. Để chạy demo cần thêm backend, cầu nối blockchain, dashboard, cấu hình và dữ liệu; tất cả nằm trong **`iot_code/full_system/`**, là một bản dự án hoàn chỉnh. Vì vậy `contracts`, `ai_model` và mã IoT xuất hiện hai lần với nội dung giống nhau: bản ở gốc để đọc và chấm, bản trong `full_system` để chạy.

**Mọi lệnh trong README này chạy tại `iot_code/full_system`:**

```powershell
cd iot_code\full_system
```

Các đường dẫn trong lệnh (ví dụ `iot_code\firmware\esp32_edge`, `data/training_30days.csv`, `docs/...`) tính từ thư mục đó. Chưa có báo cáo hoàn chỉnh: xem [dàn ý](iot_code/full_system/docs/DAN_Y_BAO_CAO.md), sau khi viết và xuất PDF đặt `Report_NhomXX.pdf` ở gốc, thay XX bằng số nhóm.

## 2. Môi trường

- Windows 10/11, PowerShell.
- Node.js >=22.13 theo `package.json`; npm.
- Python 3.12. AI dùng TensorFlow CPU 2.18.1, Keras 3.8.0, NumPy 2.0.2.
- Mosquitto, mặc định tại `C:\Program Files\mosquitto\mosquitto.exe`.
- Demo mô phỏng không cần ESP32, cảm biến hoặc MetaMask.
- ESP-IDF/PlatformIO và MetaMask chỉ cần cho các chế độ phần cứng/Web3 tương ứng.

Mở terminal **tại `iot_code/full_system`**. Với ESP-IDF/PlatformIO nên giải nén vào đường dẫn ngắn không có dấu cách, ví dụ `C:\solar-lab\p2p-solar-final`.

## 3. Cài đặt

```powershell
npm.cmd ci
py -3.12 -m venv .venv-backend
.\.venv-backend\Scripts\python.exe -m pip install -r backend/requirements.txt
npm.cmd run dashboard:build
```

Không cần kích hoạt venv hoặc đổi execution policy. Không kèm `node_modules`, môi trường Python, cache hoặc file cấu hình mạng cá nhân trong bộ nộp.

Nếu Mosquitto cài ở nơi khác:

```powershell
$env:SOLAR_MOSQUITTO_BIN = 'D:/Tools/mosquitto/mosquitto.exe'
```

Nếu dùng Python khác, truyền `--python` cho demo hoặc đặt `SOLAR_TEST_PYTHON` khi chạy test. Chỉ dùng Python có thư viện Paho MQTT cho mô phỏng.

## 4. Demo chính: smart contract qua MQTT, không cần phần cứng

```powershell
npm.cmd run simulation:market
```

Mở **http://127.0.0.1:5260/simulation**. Mặc định 12 hộ và 22 kịch bản. Chương trình tạo broker/node/ví thử nghiệm riêng, biên dịch và triển khai contract, phát telemetry/đề xuất, khóa Token, khớp lệnh rồi xác nhận giao điện hoặc hoàn tiền.

Kết quả mong đợi: 22/22 kịch bản đạt, bảo toàn Token, không còn giao dịch chờ và escrow bằng 0. Giao diện có số dư, uy tín, cọc, ưu tiên, lệnh, điện thực giao, receipt và tải báo cáo JSON. Lượt chạy lưu tại `data/market-simulation/<run_id>/`.

Giữ terminal mở để xem và chạy lượt mới; `Ctrl+C` dừng. Chỉ mở giao diện hoặc thử 32 hộ:

```powershell
npm.cmd run simulation:dashboard
npm.cmd run simulation:market -- --homes 32 --scenario basic
npm.cmd run simulation:market -- --scenario full-demo --no-dashboard
```

Chọn 6–32 hộ, seed và kịch bản trên giao diện. Nếu cổng giao diện bận, thêm `--ui-port 5261`. Broker MQTT và RPC Hardhat của mô phỏng dùng cổng trống riêng; không cần tự chạy `npm run chain` hoặc Mosquitto service cho chế độ này.

## 5. AI: trọng số có sẵn, đánh giá và huấn luyện

Mô hình MLP hồi quy dự báo công suất mặt trời/tải của `home_01` cho 5 phút tiếp theo, dùng 12 mẫu lịch sử và 53 đặc trưng. Dữ liệu tổng hợp 30 ngày được chia theo thời gian 20/5/5 ngày. Trọng số Keras, TFLite FP32/INT8, metadata và kết quả đánh giá nằm trong `ai_model/artifacts/`.

```powershell
py -3.12 -m venv .venv-ai
.\.venv-ai\Scripts\python.exe -m pip install -r ai_model/requirements.txt
.\.venv-ai\Scripts\python.exe -m ai_model.evaluate --csv data/training_30days.csv
```

Huấn luyện lại nếu cần; lệnh này cập nhật trọng số và header mô hình nhúng cho firmware:

```powershell
.\.venv-ai\Scripts\python.exe -m ai_model.train --csv data/training_30days.csv
```

Kiểm tra suy luận PC qua MQTT riêng: chạy broker local theo `mosquitto.conf`, chạy `ai_model.pc_reference` bằng `.venv-ai`, rồi phát số đo bằng `iot_code.simulator --config config/edge_demo.json`. Xem [hướng dẫn AI](iot_code/full_system/docs/EDGE_AI.md).

**Phạm vi demo:** mô phỏng thị trường nhiều hộ dùng dự báo persistence từ khoảng đo trước và gắn `simulated_forecast`; không chạy mô hình INT8 cho 12/32 hộ. Mô hình INT8 có luồng PC reference và firmware riêng. Backend Phase 2 dành cho dự báo ESP32, không nhận nhãn PC reference như dự báo phần cứng. Khi báo cáo luồng IoT → AI → Blockchain, ghi rõ chế độ, nguồn dự báo và bằng chứng thực nghiệm; không dùng kết quả kiểm thử thị trường để khẳng định đã chạy mô hình trên board.

## 6. Phần cứng: 1 ESP32 + 11 hộ mô phỏng

Nhà 1 là một ESP32 thật: đo cảm biến (2 × INA219, DS18B20), chạy mô hình INT8 bằng TensorFlow Lite Micro và gửi số đo, dự báo qua MQTT. 11 hộ còn lại là agent mô phỏng. Lệnh của Nhà 1 lấy từ dự báo trên board; 11 hộ dùng dự báo persistence.

**Nạp firmware** (PlatformIO, board ESP32 DevKit thường, Wi-Fi 2,4 GHz):

```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe"
& $pio run --project-dir "iot_code\firmware\esp32_edge" --environment esp32dev_ai
```

Lần build đầu tạo `iot_code/firmware/esp32_edge/sdkconfig.esp32dev_ai`. Mở file này, điền `CONFIG_SOLAR_WIFI_SSID`, `CONFIG_SOLAR_WIFI_PASSWORD`, `CONFIG_SOLAR_MQTT_URI` (`mqtt://<IPv4-máy-tính>:1885`) và `CONFIG_SOLAR_MQTT_PASSWORD`, rồi nạp và xem log:

```powershell
& $pio run --project-dir "iot_code\firmware\esp32_edge" --environment esp32dev_ai --target upload
& $pio device monitor --project-dir "iot_code\firmware\esp32_edge" --environment esp32dev_ai
```

Log đúng: `SELFTEST PASS` → `Wi-Fi ready` → `MQTT connected` → `AI PRED`. Tạo broker có xác thực cho board bằng `scripts/setup_edge_broker.ps1 -LanIp <IPv4-máy-tính>`. Chi tiết chân nối và các topic: [README firmware](iot_code/firmware/esp32_edge/README.md).

Các bước cho những lần chạy sau, cách lấy bằng chứng và bảng xử lý sự cố: [HUONG_DAN_CHAY_LAI.md](iot_code/full_system/docs/HUONG_DAN_CHAY_LAI.md).

**Chạy kịch bản**, mỗi lệnh một terminal:

```powershell
& 'C:/Program Files/mosquitto/mosquitto.exe' -c .local/mosquitto-edge.conf
.\.venv-backend\Scripts\python.exe -m backend --mqtt-host 127.0.0.1 --mqtt-port 1884 --port 8000 --stale-seconds 360
npm.cmd run simulation:hybrid
```

Mở **http://127.0.0.1:5260/simulation**, chọn **1 ESP32 + 11 hộ mô phỏng** và nguồn lệnh Nhà 1:

| Nguồn | Đầu vào của AI | Lệnh cho board | Chờ dự báo đầu tiên |
|---|---|---|---|
| Edge AI từ INA219 thật · 5 giây/mẫu (mặc định) | Trung bình 5 giây của cảm biến thật | Không cần, là mặc định khi khởi động | Khoảng 60 giây |
| Edge AI mô phỏng nhanh · 5 giây/mẫu | Board tự sinh mẫu | `demo on` | Khoảng 60 giây |
| Edge AI từ INA219 thật · 5 phút/mẫu | Trung bình 5 phút của cảm biến thật | `real slow` | 60–65 phút |
| Số đo gần nhất · Arduino | Không dùng AI | Firmware Arduino | Tối đa 6 phút |

Gửi lệnh bằng MQTT: `mosquitto_pub -h 127.0.0.1 -p 1884 -t solar/home_01/control -m "demo on"`. Các lệnh: `demo on`, `demo off`, `real fast`, `real slow`. Chi tiết: [HYBRID_ESP32_11_HOMES.md](iot_code/full_system/docs/HYBRID_ESP32_11_HOMES.md).

**Phạm vi:** kịch bản này chứng minh luồng cảm biến → AI trên board → MQTT → smart contract. Ở chế độ 5 giây/mẫu, mỗi mẫu được model coi là một bước 5 phút, nên thời gian phiên là thời gian logic và điện năng là giá trị quy đổi theo bước 5 phút. Độ chính xác của mô hình được đánh giá trên máy tính ở mục 5; mô hình huấn luyện trên dữ liệu tổng hợp nhà PV 4 kW, chưa hiệu chuẩn cho tấm pin thí nghiệm 3 W, nên dự báo trên board không dùng để kết luận về sai số. Lượng mua/bán của Nhà 1 lấy từ dự báo của model, nên với mạch thí nghiệm cỡ dưới 1 W nó lệch xa số đo; lệnh chỉ được đặt khi điện năng ròng dự báo đạt 1 Wh trở lên.

## 7. Web3 và thành phần khác (tùy chọn)

- Sketch Arduino: `iot_code/blockchainV2.ino`, PlatformIO trong `iot_code/firmware/blockchain_v2/`. Các thông tin Wi-Fi/MQTT cá nhân đã thay bằng placeholder, cần tự điền trước khi nạp.
- Backend: `.\.venv-backend\Scripts\python.exe -m backend`, mặc định API cổng 8000, MQTT 1884. Broker LAN/board cần cấu hình theo hướng dẫn phần cứng.
- Web3/MetaMask: xem [PHASE4.md](iot_code/full_system/docs/PHASE4.md) để chạy chain, deploy và dashboard cổng 5173. Demo mô phỏng cổng 5260 ký bằng ví Hardhat riêng tại gateway.
- Truy vết demo local bằng transaction hash, receipt và block; không gọi đây là giao dịch trên Etherscan/testnet.

## 8. Kiểm thử

```powershell
npm.cmd test
npm.cmd run test:hybrid
npm.cmd run test:simulation
npm.cmd run test:simulation:ui
.\.venv-backend\Scripts\python.exe -m unittest tests.test_model tests.test_market_simulation -v
```

Test UI dùng Chrome đã cài trên Windows hoặc Chromium Playwright. Có thể chọn browser bằng `SOLAR_BROWSER_BIN`. Test Phase 4 còn cần FastAPI và các phụ thuộc backend ở bước cài đặt:

```powershell
$env:SOLAR_BROWSER_BIN = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run test:phase4
```

Hồ sơ kiểm thử: [MQTT_SIMULATION_VALIDATION.md](iot_code/full_system/docs/MQTT_SIMULATION_VALIDATION.md), [SMART_CONTRACT_FEATURES.md](iot_code/full_system/docs/SMART_CONTRACT_FEATURES.md). Danh mục file kèm mã băm: `docs/SUBMISSION_MANIFEST.json`.

## 9. Giới hạn và thông tin nộp

- Điện/công tơ của mô phỏng là giả lập; báo cáo JSON ghi `physical_delivery_verified=false`.
- Xác nhận giao điện và nhóm ưu tiên tin cậy điều phối viên/oracle; hash không tự chứng minh điện vật lý.
- Token và mnemonic Hardhat là dữ liệu demo công khai, không dùng ví/tiền thật.
- Trọng số và dữ liệu đánh giá AI đã kèm; không cam kết độ chính xác trên dữ liệu cảm biến thực.
- Điền thông tin nhóm, hoàn thiện `Report_NhomXX.pdf`, chuẩn bị demo/thuyết trình trước khi nộp repository. Bộ mã này chưa được tự động đăng GitHub hoặc gửi LMS.
