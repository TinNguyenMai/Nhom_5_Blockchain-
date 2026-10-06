# Phase 2 — Backend MQTT, SQLite và đề xuất mua/bán điện

Bản bổ sung ngày 27/09/2026. Dùng tiếp simulator và firmware ESP32 đã chạy được ở Phase 1.

## 1. Kết quả của Phase 2

- FastAPI nhận số đo ba nhà và dự báo Nhà 1 qua broker đang dùng.
- SQLite giữ dữ liệu sau khi tắt/mở backend; tách từng lượt bằng `run_id`.
- Bản tin trùng không được ghi thêm; bản tin cùng định danh nhưng khác nội dung bị từ chối.
- Từ dự báo ESP32, backend tính đề xuất `sell`, `buy` hoặc `hold` cho khoảng 5 phút tiếp theo.
- Trang theo dõi tại `http://127.0.0.1:8000`; API có tài liệu tại `/docs`.

Đây là backend và trang kiểm tra cục bộ. Chưa ghép người mua với người bán, chưa có giá, token, thanh toán, Solidity hoặc MetaMask. Lượng điện dự báo không phải lượng điện đã giao. Cảm biến đầu vào vẫn được mô phỏng; AI chạy trên board như Phase 1.

## 2. Chép phần bổ sung vào dự án hiện tại

Giải nén `p2p-solar-phase2-addon.zip` ra thư mục tạm. Chép ba mục sau vào thư mục gốc dự án đang sử dụng:

1. Thư mục `backend`.
2. File `PHASE2.md`.
3. File `PHASE2_VALIDATION.md`.

Thư mục đích của bạn:

```text
C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1
```

Sau khi chép, `backend`, `iot_code`, `ai_model`, `firmware`, `config` phải nằm cùng cấp. Giữ nguyên các file firmware, `sdkconfig`, `mosquitto.conf`, cấu hình VS Code và dữ liệu đang dùng trên máy. Gói addon chỉ thêm backend, không chứa cấu hình kết nối của bạn.

Nếu dùng ZIP dự án đầy đủ thay vì addon, cũng chỉ chép ba mục trên vào dự án đang chạy. Firmware trong ZIP đầy đủ là bản nguồn đã lưu, không chứa các sửa đổi/cấu hình riêng trên máy bạn.

## 3. Cài môi trường backend — chỉ cần làm lần đầu

Mở **PowerShell thường** trong VS Code. Không cài các thư viện này vào môi trường ESP-IDF.

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
Test-Path .\backend\__main__.py
```

Cần trả về `True`. Dùng Python đang chạy được của Phase 1 để tạo môi trường riêng:

```powershell
.\.venv\Scripts\python.exe -m venv .venv-backend
.\.venv-backend\Scripts\python.exe -m pip install -r .\backend\requirements.txt
```

Không cần kích hoạt `Activate.ps1`, không cần TensorFlow, Node.js, Hardhat hoặc cài SQLite riêng. Bộ mã cần Python 3.10 trở lên; đã kiểm thử bằng Python 3.12. Giữ môi trường `.venv` cũ để chạy simulator/monitor.

## 4. Chạy theo thứ tự

| Terminal | Chương trình | Môi trường |
|---|---|---|
| 1 | Broker Mosquitto | PowerShell thường |
| 2 | Serial monitor ESP32 | ESP-IDF Terminal |
| 3 | Backend Phase 2 | PowerShell, `.venv-backend` |
| 4 | Simulator | PowerShell, `.venv` Phase 1 |

Subscriber CSV, Edge Monitor và panel Phase 1 có thể chạy thêm, nhưng không bắt buộc để backend lưu database. Nếu muốn đồng thời lấy số đo đánh giá AI bằng `summary.json`, mở Edge Monitor trước simulator như Phase 1.

### Terminal 1 — broker

Nếu broker đang chạy tốt, giữ terminal đó. Không mở thêm broker thứ hai cùng cổng.

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
& "C:\Program Files\mosquitto\mosquitto.exe" -c .\mosquitto.conf -v
```

Cấu hình hiện tại của bạn có một broker với hai listener: Python trên máy dùng `127.0.0.1:1884`; ESP32 dùng IP LAN máy tính, gần nhất là `192.168.1.17:1885`. Giữ nguyên cấu hình đã chạy được. Nếu IP LAN đổi sau khởi động máy, cần cập nhật listener LAN và URI firmware theo hướng dẫn Phase 1.

### Terminal 2 — ESP32

Mở `Ctrl+Shift+P` → `ESP-IDF: Open ESP-IDF Terminal`:

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1\iot_code\firmware\esp32_edge"
idf.py -p COM4 monitor
```

Giữ board cắm USB và đợi kết nối MQTT. Firmware đã nạp thì không cần build/flash lại chỉ để thêm backend. Nếu board đã chạy từ trước, log kết nối cũ có thể không in lại; nhấn EN một lần trước khi bắt đầu simulator nếu cần xem boot log. Thoát monitor bằng Ctrl+].

### Terminal 3 — backend

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
.\.venv-backend\Scripts\python.exe -m backend --mqtt-host 127.0.0.1 --mqtt-port 1884
```

Chờ:

```text
READY backend MQTT 127.0.0.1:1884
```

Mở `http://127.0.0.1:8000` bằng trình duyệt. Trang phải hiện **MQTT đã kết nối**. Ban đầu chưa có số đo là bình thường. Giữ terminal backend chạy.

Backend cố gắng kết nối lại nếu broker chưa chạy; không cần chạy lại backend sau khi mở broker. `/health` báo HTTP đang hoạt động; `/ready` chỉ trả 200 khi đã kết nối, đăng ký MQTT và chưa có lỗi lưu trữ. `/ready` trả 503 trong lúc chưa sẵn sàng là đúng.

### Terminal 4 — thử nhanh khoảng một phút

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
.\.venv\Scripts\python.exe -m iot_code.simulator --host 127.0.0.1 --port 1884 --config .\config\edge_demo.json --dataset --steps 30 --interval 2
```

Chỉ chạy một simulator tại một thời điểm. Sau khoảng 25 giây, ESP32 nhận đủ 12 mẫu và bắt đầu dự báo. Backend in `PRED saved ...`, trang web có dự báo và đề xuất.

Nếu thu đủ từ đầu, lượt 30 khoảng có **90 số đo, 19 dự báo, 19 bản ghi đề xuất**. Đề xuất gồm cả `hold` nếu lượng quá nhỏ; không phải mọi bản ghi đều là lệnh bán. Sau khi simulator tự dừng, thường có 18 đề xuất `observed` và một đề xuất cuối `stopped`. Đây không phải lỗi.

### Lượt nghiệm thu 24 giờ giả lập

Sau khi lượt nhanh tự dừng, chạy ở terminal simulator:

```powershell
.\.venv\Scripts\python.exe -m iot_code.simulator --host 127.0.0.1 --port 1884 --config .\config\edge_demo.json --dataset --steps 288 --interval 2
```

Lượt này mất khoảng 10 phút thực. Mỗi khoảng vẫn là 300 giây giả lập. Dự kiến **864 số đo, 277 dự báo, 277 đề xuất** nếu không mất bản tin. Số tổng database cộng cả lượt trước; chọn đúng `run_id` để nghiệm thu riêng một lượt. Chạy lại tạo run mới, không xóa dữ liệu cũ.

## 5. Đọc đề xuất và đơn vị

Quy tắc mặc định là quy tắc demo có thể cấu hình, chưa phải thuật toán tối ưu giao dịch:

```text
net_kw = predicted_solar_kw - predicted_load_kw
forecast_net_kwh = net_kw × 300 / 3600

nếu dư:    sell_quantity = forecast_net_kwh × 0.8
nếu thiếu: buy_quantity = abs(forecast_net_kwh)
nếu quantity < 0.01 kWh: hold, quantity = 0
```

Ví dụ dự báo phát 3 kW, tải 1 kW → dư 0,166667 kWh trong 5 phút → đề xuất bán 0,133333 kWh sau khi giữ lại 20%. Lượng đề xuất được làm tròn xuống 6 chữ số thập phân. Không dùng `--interval 2` thay cho 300 giây khi đổi kW sang kWh.

Đề xuất có `input_event_id`, `run_id`, `target_timestamp`, `model_version`, `device_id`, chính sách và lượng điện để truy vết. Mỗi dự báo của mỗi thiết bị/model tạo một bản ghi đề xuất; đây là các ứng viên, không phải các giao dịch được cộng dồn hay tự thực thi.

| Trạng thái | Ý nghĩa |
|---|---|
| `proposed` | Có dự báo mới và số đo đầu vào tương ứng, khoảng đích chưa tới; có thể xem xét |
| `below_threshold` | Lượng điện nhỏ hơn ngưỡng; đề xuất `hold` |
| `observed` | Số đo của khoảng đích đã đến; chỉ còn dùng đối chiếu |
| `late` | Dự báo tới backend sau khi luồng số đo đã tới/vượt khoảng đích |
| `expired` | Luồng đã vượt khoảng đích nhưng thiếu đúng số đo đích |
| `awaiting_input` | Chưa nhận được số đo mà dự báo tham chiếu; tự ghép khi số đo đến |
| `invalid_input` | Định danh đầu vào có timestamp không khớp với dự báo |
| `paused`, `stopped`, `offline`, `error` | Trạng thái simulator; đề xuất không còn để xem xét trực tiếp |
| `disconnected`, `stale`, `archived` | Mất MQTT, quá 60 giây thực không còn đủ độ mới, hoặc thuộc lượt cũ |

`eligible_for_review=true` chỉ có khi `status=proposed`; đây không phải xác nhận đủ điều kiện thanh toán. Mọi bản ghi luôn có `on_chain=false` và `purpose=advisory_only`. Khi có số đo đích, `actual_net_kwh` là chênh lệch phát/tải mô phỏng, không chứng minh điện đã được giao cho một đối tác.

Timestamp mô phỏng dùng múi giờ +07:00 và bước 5 phút. Kiểm tra quá hạn theo tiến độ số đo của cùng run/nhà, không so trực tiếp ngày giả lập với đồng hồ Windows. Cờ `stale` dùng tuổi nhận bản tin theo giây thực. `received_at` của backend là UTC.

## 6. API và kiểm tra kết quả bằng PowerShell

| API GET | Nội dung |
|---|---|
| `/health` | Trạng thái backend/MQTT, lỗi gần nhất, tổng số bản ghi, đường dẫn DB |
| `/ready` | Sẵn sàng thu MQTT (200), hoặc chưa sẵn sàng (503) |
| `/api/runs` | Các lượt gần nhất, số telemetry và prediction từng lượt |
| `/api/homes` | Số đo mới nhất mỗi nhà của lượt mới nhất hoặc run được chọn |
| `/api/telemetry` | Lịch sử số đo |
| `/api/predictions` | Lịch sử dự báo ESP32 |
| `/api/proposals` | Lịch sử đề xuất và trạng thái hiện tại |
| `/api/overview` | Dữ liệu tổng hợp cho trang theo dõi |

Các API lịch sử hỗ trợ `run_id`, `household_id`, `limit` (1..500), `offset`. Mặc định API lịch sử trả các run; dùng `run_id` khi so sánh một lượt. Trang web mặc định theo dõi run được backend nhìn thấy lần đầu gần nhất. “Dự báo gần nhất” của lượt đã kết thúc vẫn là bản lịch sử, không tự trở thành dữ liệu mới.

Sau khi simulator dừng, tại PowerShell mới:

```powershell
$runId = (Invoke-RestMethod "http://127.0.0.1:8000/api/runs").items[0].run_id

(Invoke-RestMethod "http://127.0.0.1:8000/api/telemetry?run_id=$runId&limit=1").total
(Invoke-RestMethod "http://127.0.0.1:8000/api/predictions?run_id=$runId&limit=1").total
(Invoke-RestMethod "http://127.0.0.1:8000/api/proposals?run_id=$runId&limit=1").total

(Invoke-RestMethod "http://127.0.0.1:8000/api/proposals?run_id=$runId&limit=500").items |
    Group-Object action | Select-Object Name, Count
```

Với lượt 288 bước đủ dữ liệu, ba lệnh `.total` trả về `864`, `277`, `277`. Nếu thấp hơn, kiểm tra backend đã READY trước simulator chưa, log ESP32, và `rejected`/`storage_errors` trong `/health`. Không kết luận mất dữ liệu chỉ vì API trả mặc định 100 dòng; xem trường `total` và phân trang.

Xuất đề xuất của lượt 288 bước (dưới 500 bản ghi):

```powershell
$result = Invoke-RestMethod "http://127.0.0.1:8000/api/proposals?run_id=$runId&limit=500"
$result | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 ".\data\phase2_proposals_$runId.json"
```

## 7. Dừng, mở lại và giữ dữ liệu

1. Đợi simulator tự dừng hoặc Ctrl+C simulator trước.
2. Đợi 5 giây rồi Ctrl+C backend. Đóng Edge Monitor bình thường nếu đang dùng để ghi summary của Phase 1.
3. Có thể giữ broker/board chạy hoặc đóng sau cùng.
4. Khởi động lại backend bằng cùng lệnh. Mở trang web: các run và số bản ghi cũ vẫn còn.

Database mặc định là `data/phase2.sqlite3` trong dự án. Khi đang chạy có thể có thêm `-wal` và `-shm`; không xóa các file này khi backend đang chạy. Muốn sao lưu đơn giản, dừng backend bình thường rồi chép file SQLite cùng ảnh/JSON kết quả. Muốn thử một database riêng mà giữ dữ liệu cũ:

```powershell
.\.venv-backend\Scripts\python.exe -m backend --db .\data\phase2_demo_moi.sqlite3
```

Không cần nạp lại ESP32, tạo lại mô hình hay dataset 30 ngày để chạy Phase 2. Database không tự đọc lại CSV Phase 1; backend thu các bản tin mới kể từ khi đăng ký MQTT. Broker demo không lưu lịch sử để phát bù lúc backend tắt.

Khi đưa code lên Git, bổ sung các dòng sau vào `.gitignore` hiện có:

```gitignore
.venv-backend/
data/*.sqlite3*
data/phase2_proposals_*.json
.pytest_cache/
```

## 8. Tùy chọn và giới hạn

- `--port 8001`: đổi cổng HTTP khi 8000 bị chiếm; mở URL tương ứng.
- `--sell-reserve 0.2 --minimum-kwh 0.01`: chính sách đề xuất mới; lịch sử giữ chính sách cũ của từng bản ghi.
- `--config .\config\edge_demo.json`: danh sách nhà hợp lệ. Nếu simulator dùng cấu hình khác, backend phải biết cùng danh sách nhà; mô hình ESP32 vẫn chỉ được kiểm chứng với edge_demo.
- `--device-id esp32-6825ddef0120`: chỉ nhận dự báo mang đúng ID board của bạn. Đây là lọc trường payload, không phải xác thực mật mã.
- `--no-mqtt`: chỉ đọc lịch sử đã lưu, không thu dữ liệu mới.

Backend chỉ lắng nghe HTTP tại 127.0.0.1. Chạy một instance trên cùng DB; không dùng nhiều worker hoặc auto-reload. Dữ liệu MQTT hiện thuộc môi trường demo LAN tin cậy. Backend kiểm tra schema/định danh/đơn vị, không chứng minh nguồn vật lý bằng chữ ký. Không có endpoint HTTP cho phép tạo giao dịch hoặc chèn số đo. Nhà 2/3 chỉ lưu telemetry, chưa có AI riêng; chưa tạo AI giả cho hai nhà đó.

Các kiểm tra định dạng chính: run_id 32 ký tự hex, household khớp topic và config, số hữu hạn, công suất/điện năng nhất quán, bước 300 giây, timestamp đúng +07:00, dự báo đích sau đầu vào 5 phút, device_kind=esp32. Bản tin retained bị bỏ qua để không coi dữ liệu cũ là luồng mới. QoS1 và khóa duy nhất chống trùng; không cam kết phát bù sau mất phiên hoặc mất nguồn.

## 9. Lỗi thường gặp

| Hiện tượng | Xử lý |
|---|---|
| `No module named backend` | Chạy tại thư mục gốc, kiểm tra backend không bị lồng thêm một cấp |
| `No module named fastapi` | Dùng `.venv-backend\Scripts\python.exe`, cài requirements của backend |
| `No module named iot_code` | Addon phải nằm cùng cấp với iot_code của Phase 1 |
| Trang có dữ liệu cũ nhưng MQTT chưa sẵn sàng | Mở broker, kiểm tra Python dùng 1884; chờ tự kết nối lại |
| Có telemetry nhưng 0 prediction | Kiểm tra ESP32 đã MQTT connected, chờ 12 mẫu, xem có PRED và log REJECT không |
| Không thấy cả ba nhà | Cấu hình simulator phải khớp config của backend; xem trường rejected |
| `stopped`/277 sau lượt 288 bước | Bình thường: simulator đã hoàn tất, đề xuất cuối chưa có số đo tương lai |
| `database is locked` | Dừng instance backend thừa và phần mềm đang khóa SQLite, rồi chạy lại một instance |
| `WinError 10048`/address in use | Đóng backend cũ hoặc dùng `--port 8001` |
| `/docs` không hiện khi mất Internet | Swagger dùng tài nguyên CDN; trang theo dõi `/` và API JSON vẫn chạy cục bộ |

## 10. Điều kiện nghiệm thu Phase 2

- Backend READY và nhận đúng telemetry ba nhà, prediction từ board Nhà 1.
- Trang/API hiện dự báo, đề xuất mua/bán/hold và nguồn/model/run rõ ràng.
- Lượt 288 bước đủ dữ liệu có 864 telemetry, 277 prediction và 277 proposal theo cùng run.
- Tắt/mở backend vẫn thấy dữ liệu cũ; chạy simulator lượt mới không trộn định danh.
- Lưu ảnh trang, JSON đề xuất và bản sao DB sau khi dừng. Kết quả đo trên board cũ nằm trong hồ sơ Phase 1; lượt Phase 2 cần xác nhận thêm tại máy bạn.

Bước tiếp theo của đồ án là Smart Contract: đăng ký hộ/ví, tạo phiên chào mua/bán, khớp lệnh và cơ chế quyết toán dựa trên số đo. Các đề xuất Phase 2 cung cấp dữ liệu đầu vào có thể truy vết cho bước đó.

Tham khảo triển khai: [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/), [Paho MQTT Python](https://eclipse.dev/paho/clients/python/docs/), [SQLite WAL](https://www.sqlite.org/wal.html).
