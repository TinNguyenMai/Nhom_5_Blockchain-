# Mô phỏng thị trường điện nhiều hộ qua MQTT

**Đánh giá trực quan:** xem [SIMULATION_EVALUATION.md](SIMULATION_EVALUATION.md) để đọc biểu đồ, lọc kịch bản, đối chiếu tiền/uy tín và xuất hình/dữ liệu từ dashboard. Lượt chạy mới lưu lịch sử từng bước; báo cáo cũ vẫn mở được.

Toàn bộ luồng chạy trên một máy tính, không cần ESP32, cảm biến, inverter hoặc MetaMask. Mỗi hộ có kết nối MQTT và ví Hardhat riêng. MQTT dùng Mosquitto thật; lệnh, khóa Token, khớp lệnh, uy tín, đặt cọc và ưu tiên được xử lý bằng smart contract đã triển khai trên blockchain local.

## Chạy trên máy hiện tại

Máy đã có Node, môi trường `.venv-runtime` và Mosquitto. Tại thư mục dự án:

```powershell
npm.cmd run dashboard:build
npm.cmd run simulation:market -- --python .venv-runtime/Scripts/python.exe
```

Mở **http://127.0.0.1:5260/simulation**. Chương trình tự chạy 12 phiên cộng đồng biến động với 12 hộ: nắng/mây/mưa, tải tăng giảm, giao thiếu và phục hồi uy tín. Chọn **Toàn bộ chức năng** để chạy bộ 22 kiểm thử contract. Giữ terminal mở để xem kết quả và chạy lượt mới trên giao diện. `Ctrl+C` dừng các tiến trình của lượt mô phỏng.

Chỉ mở giao diện, bấm nút khi muốn bắt đầu:

```powershell
npm.cmd run simulation:dashboard -- --python .venv-runtime/Scripts/python.exe
```

Chạy thị trường 32 hộ hoặc chỉ kiểm thử qua terminal:

```powershell
npm.cmd run simulation:market -- --homes 32 --scenario basic
npm.cmd run simulation:market -- --scenario full-demo --no-dashboard
```

Mỗi lượt tạo node Hardhat, triển khai Token/thị trường và broker riêng trên cổng trống. Chương trình không kết nối broker ESP32 đang chạy. Dữ liệu lưu riêng tại `data/market-simulation/<run_id>/`, không ghi vào dữ liệu Phase 2/3. Cổng giao diện mặc định 5260; dùng `--ui-port 5261` nếu đã có tiến trình khác sử dụng cổng này.

Sau khi hoàn tất, node/broker tiếp tục chạy để xem trạng thái. Chạy lượt mới sẽ đóng tài nguyên của lượt trước và tạo lượt mới. Khi khởi động lại chương trình, giao diện đọc kết quả đã lưu; đây là báo cáo cũ, không khôi phục blockchain đã bị dừng. Lượt bị ngắt được đánh dấu `interrupted`.

## Phụ thuộc khi chuyển sang máy khác

Node theo `package.json` (>=22.13), Python 3.12/3.13 với `paho-mqtt==2.1.0`, và Mosquitto. Cài thư viện nếu chưa có:

```powershell
npm.cmd ci
python -m venv .venv-backend
.\.venv-backend\Scripts\python.exe -m pip install -r requirements.txt
```

Mặc định tìm Mosquitto tại `C:\Program Files\mosquitto\mosquitto.exe`. Có thể chỉ định đường dẫn khác:

```powershell
$env:SOLAR_MOSQUITTO_BIN = 'D:/Tools/mosquitto/mosquitto.exe'
npm.cmd run simulation:market -- --python 'D:/Python/python.exe'
```

Sau khi cài phụ thuộc, mô phỏng chạy local không cần Internet, không dùng tiền hoặc ví thật. Các ví sử dụng mnemonic Hardhat công khai; chỉ dùng trong môi trường thử nghiệm này.

## Các thành phần và luồng

```text
Orchestrator → MQTT → các HouseholdAgent
                         ├─ số đo công tơ ảo → MQTT → SQLite
                         ├─ đề xuất mua/bán → MQTT → kiểm tra nguồn
                         ├─ yêu cầu đặt/hủy → MQTT → gateway → ví hộ → EnergyMarket
                         └─ công tơ giao điện → MQTT → gateway/oracle → confirmTrade
EnergyMarket → receipt + số dư + uy tín → MQTT + dashboard + báo cáo
```

| Thành phần | Mã nguồn |
| --- | --- |
| Hồ sơ hộ, seed, giá và tải | `config/market_simulation.json` |
| Một MQTT client cho mỗi hộ | `iot_code/household_agent.py` |
| Sinh số đo, đề xuất và lệnh | `iot_code/market_simulator.py` |
| Công tơ xuất/nhập tích lũy, tính lượng giao | `iot_code/delivery_model.py` |
| MQTT transport và lưu lịch sử | `iot_code/market_transport.py`, `backend/market_storage.py` |
| Kiểm tra bản tin | `backend/market_validation.py`, `blockchain/lib/mqtt-schema.mjs` |
| Ký lệnh bằng ví từng hộ, xác nhận bởi điều phối viên | `blockchain/mqtt-gateway.mjs` |
| Lưu giao dịch đã ký trước khi broadcast | `blockchain/lib/transaction-journal.mjs` |
| Các kịch bản và đối chiếu kết quả | `blockchain/market-orchestrator.mjs` |
| Khởi chạy, quản lý tài nguyên, HTTP local | `blockchain/simulation-market.mjs`, `blockchain/simulation-server.mjs` |
| Giao diện React | `dashboard/src/Simulation.jsx` |

Các hộ trao đổi qua MQTT; gateway giữ các khóa **thử nghiệm** để ký thay từng hộ. Xác nhận giao điện và gán nhóm ưu tiên được ký bằng ví điều phối viên. Đây là kiến trúc mô phỏng có gateway/oracle được tin cậy, chưa phải hệ thống ký độc lập trên từng thiết bị.

Mặc định 12 hộ gồm nhà có điện mặt trời, nhà tiêu thụ, bệnh viện công/tư, trường mầm non và hộ đặc biệt. Giao diện cho chọn 6–32 hộ, kịch bản và seed. Thêm hộ trên 12 sẽ tự sinh hồ sơ. Số lượng bị giới hạn bởi tối đa 32 hộ/lệnh của hợp đồng.

Đề xuất dùng cách dự báo đơn giản: lấy điện ròng của khoảng đo trước để ước tính khoảng 5 phút tiếp theo. Toàn bộ được gắn `device_kind=simulator`, `basis=simulated_forecast`; hợp đồng lưu `Basis.SimulatedForecast=2`. Các giá trị enum cũ 0/1 giữ nguyên. Đây là dự báo mô phỏng, không phải kết quả model AI trên ESP32.

Seed cố định cho cùng số đo khi cấu hình và chuỗi bước giống nhau. `run_id`, thời gian nhận, địa chỉ cổng, transaction hash có thể khác giữa các lượt.

## Chức năng và kịch bản

| Tùy chọn `--scenario` | Nội dung |
| --- | --- |
| `community` (mặc định) | 12 phiên × 5 phút, thời tiết và phụ tải biến động; đề xuất từ số đo từng hộ, giao thiếu và phục hồi uy tín |
| `full-demo` | 22 kiểm tra nghiệp vụ, bao gồm mọi nhóm bên dưới |
| `basic` | Các hộ tạo đề xuất từ điện phát/tải, đặt lệnh, khóa tiền, khớp và giao đủ |
| `priority` | Bệnh viện công/tư, mầm non, hộ đặc biệt cùng giá; giá cao hơn thắng; ngang ưu tiên theo thứ tự |
| `reputation` | Giao thiếu, giảm/phục hồi điểm, cọc hai bên, phạt và giới hạn cộng dồn nhiều phiên |
| `resilience` | Yêu cầu trùng, gateway khởi động lại sau receipt, broker ngắt/kết nối lại |

Trong `full-demo` có thêm hủy/hoàn tiền, giá không khớp, khớp một phần, thiếu số dư/allowance, quyền điều phối giả, đặt/kết toán sai hạn, bằng chứng công tơ sai, quá hạn hoàn tiền và nhiều phiên giữ escrow độc lập.

Người mua khóa tiền **trước khi đặt lệnh**. Kết toán hoàn phần không sử dụng và chênh giá, tiếp tục giữ tiền/cọc phần khớp. Chỉ `confirmTrade` với bằng chứng hợp lệ mới trả người bán theo lượng giao; `expireTrade` hoàn tiền khi quá hạn. Công tơ mô phỏng ghi cả điện xuất của người bán và điện nhập của người mua; gateway kiểm tra hai chênh lệch bằng lượng báo giao, đúng đối tác và không lùi chỉ số.

Các mức uy tín/cọc/giới hạn giữ chính sách trong [SMART_CONTRACT_FEATURES.md](SMART_CONTRACT_FEATURES.md). Các nhóm đặc biệt ngang mức ưu tiên, chỉ ưu tiên khi giá mua bằng nhau. Gán nhóm dùng hồ sơ đăng ký giả lập do điều phối viên xác nhận.

Kịch bản biên có lượng/giá đặt cố định để kiểm tra hợp đồng, được ghi rõ `override_reason=deterministic_contract_scenario`. Các lượng lớn kiểm tra giới hạn không đại diện sản lượng thực của hộ. Các lần bị từ chối có chủ đích là kết quả mong đợi; xem danh sách **kịch bản đạt**, không suy ra lỗi từ số bản tin bị từ chối.

Orchestrator tăng thời gian trên **node Hardhat do chính lượt chạy tạo** để tới hạn đặt lệnh/xác nhận. Không cần đợi 24 giờ thật. Thời gian công tơ và thời gian blockchain là hai đồng hồ riêng của mô phỏng.

## MQTT và định dạng

QoS 1, không dùng retained message cho giao dịch. Các bản tin JSON tối đa 16 KiB; bản tin trạng thái chỉ chứa tóm tắt receipt, log đầy đủ lưu trong journal.

| Topic | Vai trò |
| --- | --- |
| `solar/<home>/simulation/request` | Lệnh điều khiển hộ: `sample`, `place_order`, `cancel_order`, `delivery` |
| `solar/<home>/simulation/status` | Hộ đã lấy mẫu, offline, hoặc từ chối command |
| `solar/<home>/telemetry` | Số đo điện/thời tiết ảo |
| `solar/<home>/prediction` | Đề xuất và tham chiếu số đo nguồn |
| `solar/<home>/order/request` / `order/status` | Yêu cầu đặt/hủy và kết quả blockchain |
| `solar/<home>/delivery` | Xác nhận giao điện kèm công tơ xuất/nhập |
| `solar/<home>/reputation` | Điểm, cọc, giới hạn, cam kết, số dư cập nhật |
| `solar/<home>/priority/status` | Nhóm đã được điều phối viên xác nhận |
| `solar/market/round/request` / `round/status` | Mở hoặc kết toán phiên |
| `solar/market/priority/request` / `priority/status` | Gán/bỏ ưu tiên |
| `solar/market/delivery/request` / `delivery/status` | Yêu cầu hoàn quá hạn; kết quả xác nhận/hoàn |
| `solar/market/trade/<round>` | Thông báo giao dịch được khớp |
| `solar/market/snapshot` | Tổng escrow, số phiên, kiểm tra bảo toàn Token |

Envelope chung:

```json
{
  "schema_version": 1,
  "message_id": "uuid-cua-command",
  "run_id": "32-ky-tu-hex",
  "deployment_id": "0x...",
  "household_id": "home_02",
  "action": "place_order",
  "payload": { "round_id": "1" }
}
```

Đây là command gửi tới `solar/home_02/simulation/request`; hộ bổ sung side/lượng/giá từ đề xuất hiện tại và phát yêu cầu blockchain. `side=0` bán, `side=1` mua. Lượng Wh và giá **micro-SLC/Wh** là chuỗi số nguyên. Token có 6 số thập phân: giá `2000` tương đương 2 SLC/kWh; 100 Wh giá đó tương đương 0,2 SLC.

`message_id` phải duy nhất, 1–100 ký tự chữ/số/gạch ngang/gạch dưới. Khi phát lại, giữ nguyên toàn bộ nội dung; cùng ID khác nội dung bị từ chối. Hộ dùng ID hậu tố `-wire` cho yêu cầu blockchain và giữ `correlation_id` trỏ về command. Đề xuất mang `input_message_id`, `input_event_id`, thời gian đích để đối chiếu số đo nguồn.

SQLite lưu bản tin hợp lệ, bỏ trùng và phát hiện xung đột ID. Gateway lưu raw transaction đã ký, hash, nonce **trước broadcast**, khi phục hồi gửi lại chính giao dịch đó. Bộ test tiêm lỗi trước broadcast và sau receipt để chứng minh không tạo thêm lệnh/nonce. Broker được dừng/khởi động lại thật trong kịch bản resilience; việc mất bản tin được xử lý bằng gửi lại yêu cầu cùng ID. Phục hồi gateway trong cùng lượt giữ node, broker và công tơ đang chạy; chưa hỗ trợ phục hồi toàn bộ blockchain local sau khi đóng chương trình.

## Kết quả và hồ sơ

Dashboard hiển thị điện phát/tải, đề xuất, nhóm ưu tiên, điểm, cọc, giới hạn/cam kết, số dư; chọn phiên để xem sổ lệnh, điện cam kết/thực giao, tiền trả, trạng thái và hash bằng chứng. Có lịch sử MQTT, receipt/block và nút tải JSON.

| File trong thư mục lượt chạy | Nội dung |
| --- | --- |
| `deployment.json`, `config.json` | Địa chỉ contract/ví và cấu hình lượt |
| `mqtt.sqlite3` | Lịch sử MQTT đã kiểm tra và lý do bản tin sai |
| `mqtt-sources.json` | Số đo/đề xuất để phục hồi gateway |
| `meters.json` | Công tơ tích lũy, command và kết quả phát từ hộ |
| `transactions.json` | Journal ký, nonce/hash/raw, receipt đầy đủ, kết quả yêu cầu |
| `evidence/<message_id>.json` | Bằng chứng lệnh và giao điện, liên kết qua hash |
| `snapshot.json` | Trạng thái on-chain mới nhất |
| `checks.json`, `report.json` | Kết quả từng kiểm tra và báo cáo tổng hợp |

`data/market-simulation/latest.json` lưu trạng thái gần nhất để giao diện đọc sau khi mở lại. Token được đối chiếu sau mỗi kiểm tra: **tổng số dư các hộ + escrow = tổng Token cấp đầu lượt**. Bộ demo hoàn tất khi không còn giao dịch pending, escrow bằng 0 và tất cả kiểm tra đạt.

Điện và xác nhận công tơ vẫn là mô phỏng. Báo cáo ghi `data_kind=hardware_free_simulation`, `physical_delivery_verified=false`; giao dịch Token có receipt thật trên Hardhat local. Hash bằng chứng chứng minh nội dung được liên kết với giao dịch, không chứng minh đã chuyển điện vật lý.

## Kiểm thử tự động

Kết quả trên máy: [MQTT_SIMULATION_VALIDATION.md](MQTT_SIMULATION_VALIDATION.md).

```powershell
npm.cmd run test:simulation
npm.cmd run test:simulation:ui
npm.cmd test
$env:SOLAR_BROWSER_BIN = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm.cmd run test:phase4
```

`test:simulation`: 4 kiểm thử Python về validation/SQLite/công tơ, 3 kiểm thử Node về schema, bộ 22 kịch bản với 12 ví và phục hồi transaction trước broadcast, thị trường 32 hộ qua MQTT thật. Các lượt test lưu vào thư mục tạm và không ghi đè báo cáo demo.

`test:simulation:ui`: chạy một lượt thật qua trình duyệt; kiểm tra 12 hộ, lọc hộ, receipt, xuất JSON, bảo toàn Token, bố cục 390px, lỗi JavaScript và các yêu cầu HTTP sai phiên/origin/tham số/trùng lượt. Trên Windows dùng Chrome đã cài nếu Chromium Playwright chưa có; biến `SOLAR_BROWSER_BIN` cho phép chọn đường dẫn. Ảnh nằm trong `dashboard/test-results/simulation-desktop.png` và `simulation-mobile.png`.
