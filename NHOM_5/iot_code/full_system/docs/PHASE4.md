# Phase 4 — React, MetaMask và thị trường điện local

**Cập nhật smart contract 03/10/2026:** xem [SMART_CONTRACT_FEATURES.md](SMART_CONTRACT_FEATURES.md). Khớp lệnh giữ tiền chờ xác nhận giao điện; bổ sung uy tín, đặt cọc và ưu tiên cùng giá. Mô tả thanh toán ngay khi kết toán bên dưới thuộc bản cũ.

Phase 4 bổ sung giao diện để xem dữ liệu, chọn đề xuất ESP32, ký lệnh bằng MetaMask, hủy lệnh, kết toán và kiểm tra biên nhận. Giao diện dùng lại hai hợp đồng `SolarToken` / `EnergyMarket` của Phase 3. SLC là token thử nghiệm; số đo đầu vào vẫn là mô phỏng.

**Bắt đầu bằng Replay trên dữ liệu Phase 2 đã lưu.** Bạn không cần chạy lại 288 khoảng đo để thử giao diện. Phase 3 của bạn đã xác nhận được luồng live; lượt đầu của Phase 4 tập trung kiểm tra thao tác ví và giao diện.

## 1. Cập nhật vào dự án đang có

Dùng **p2p-solar-phase4-addon.zip** cho máy đã chạy Phase 3. Giải nén nội dung vào:

```text
C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1
```

Trong thư mục gốc phải thấy đồng thời `package.json`, `dashboard`, `blockchain`, `backend` và `PHASE4.md`. Tránh tạo thêm tầng `p2p-solar-phase1\p2p-solar-phase1`.

Nếu dùng PowerShell và file nằm ở Downloads:

```powershell
$project = "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
Expand-Archive -Path "$env:USERPROFILE\Downloads\p2p-solar-phase4-addon.zip" -DestinationPath $project -Force
Set-Location $project
```

Gói addon thêm `dashboard/`, tài liệu/ảnh và cập nhật `package.json`, `package-lock.json`, `README.md`, `.gitignore`, `blockchain/lib/market.mjs`. Gói không chứa `mosquitto.conf`, firmware, `sdkconfig`, SQLite, thư mục `data/phase3`, hay khóa ví. Các chỉnh sửa Wi-Fi/ESP32 tại máy của bạn được giữ nguyên.

Bộ đầy đủ `p2p-solar-phase1.zip` dành cho máy mới hoặc bản lưu nguồn. Không dùng bộ đầy đủ để ghi đè cấu hình MQTT/firmware bạn đã sửa.

## 2. Chuẩn bị thư viện và build giao diện

Trong một PowerShell thường ở thư mục dự án, chạy từng lệnh:

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
node --version
npm.cmd --version
npm.cmd install
npm.cmd run compile
npm.cmd run dashboard:build
```

Node 24 bạn đã cài đáp ứng cấu hình dự án. Dùng `npm.cmd` để tránh lỗi thực thi `npm.ps1` của PowerShell. `npm install` tải thư viện; cần Internet ở bước này. File lock khóa phiên bản phụ thuộc. Nếu cài sạch trên một bản sao dự án, có thể dùng `npm.cmd ci` thay cho `npm.cmd install`.

Kỳ vọng build tạo `dashboard/dist/index.html` và các file JS/CSS. Cảnh báo bundle lớn hơn 500 kB là cảnh báo tối ưu kích thước; không phải build thất bại. Bản hiện tại tải toàn bộ React/Ethers từ máy local, không dùng CDN.

## 3. Các terminal cần giữ chạy

Nếu terminal tương ứng đã chạy tốt thì giữ nguyên, không mở thêm bản thứ hai trên cùng cổng.

| Terminal | Chạy để làm gì? | Cổng |
| --- | --- | --- |
| Mosquitto | Thu dữ liệu mới từ simulator và ESP32 | 1884 local; 1885 LAN |
| Backend | Đọc SQLite, cung cấp số đo/dự báo/đề xuất | 8000 |
| Hardhat | Blockchain local và ví thử nghiệm | 8545 |
| Dashboard | Giao diện React và gateway cục bộ | 5173 |
| ESP-IDF Monitor | Theo dõi board, khi muốn xem dữ liệu mới | COM4 |

**Dừng `market:live` hoặc `demo:backend` trước khi thao tác qua MetaMask.** Nếu bridge đang chạy, nhấn Ctrl+C trong đúng terminal bridge. Bridge tự dùng các ví thử nghiệm; không để bridge và bạn đồng thời dùng cùng ví/nguồn đề xuất.

### Terminal Mosquitto — chỉ khi broker chưa chạy

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
& "C:\Program Files\mosquitto\mosquitto.exe" -c ".\mosquitto.conf" -v
```

Giữ cấu hình đã chạy thành công: backend dùng 127.0.0.1:1884, ESP32 kết nối cổng 1885 của IP LAN máy tính. IP có thể đổi sau khi khởi động lại; xem `Get-NetIPConfiguration` nếu board báo lỗi kết nối. Không thay file broker bằng cấu hình mặc định trong bộ nguồn đầy đủ.

### Terminal Backend — chỉ khi backend chưa chạy

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
.\.venv-backend\Scripts\python.exe -m backend --mqtt-host 127.0.0.1 --mqtt-port 1884
```

Nếu chỉ xem dữ liệu lịch sử, có thể dùng `--no-mqtt` thay cho hai tham số MQTT. Khi đó MQTT hiện ngoại tuyến là đúng; Replay vẫn hoạt động. Không chạy hai backend cùng cổng 8000.

Backend giữ phiên bản API 3.0.0; dashboard mới có phiên bản 4.0.0. `/health` trả 3.0.0 không phải lỗi cập nhật.

### Terminal Hardhat — chỉ khi node chưa chạy

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
npm.cmd run chain
```

Giữ terminal này mở. Node in các địa chỉ thử nghiệm và private key tương ứng. Chỉ dùng các khóa thử nghiệm đó trong môi trường local.

Trong PowerShell khác, chạy:

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
npm.cmd run deploy
```

Lệnh này tái sử dụng triển khai đang còn hợp lệ. Nếu Hardhat vừa khởi động lại, nó tạo triển khai mới với ba nhà nhận 1.000 SLC mỗi nhà. Node local mất trạng thái blockchain khi dừng; JSON và SQLite trên đĩa vẫn còn. Dashboard đối chiếu deployment ID và receipt để không nhận nhầm dữ liệu chain cũ.

### Terminal Dashboard — terminal mới cho Phase 4

```powershell
cd "C:\ANOTHER_DISK\HCMUTE\4th_YEAR\FIRST\31Blockchain\p2p-solar-phase1"
npm.cmd run dashboard
```

Mở **http://127.0.0.1:5173** bằng Chrome/Edge có MetaMask. Giữ terminal dashboard mở. Cổng 8000 là dashboard cũ của backend, không phải giao diện React mới.

Kiểm tra nhanh từ một PowerShell khác:

```powershell
Invoke-RestMethod "http://127.0.0.1:8000/health" | ConvertTo-Json -Depth 4
Invoke-RestMethod "http://127.0.0.1:5173/ui/status" | ConvertTo-Json -Depth 5
```

Kỳ vọng `/ui/status`: `connected: true`, `writer_busy: false`, `deployment.chain_id: 31337`. Số dư có thể đã khác 1.000 nếu bạn giữ node từ Phase 3; đó là lịch sử giao dịch của bạn.

## 4. Cài và chuẩn bị MetaMask

1. Cài extension từ **https://metamask.io/download/** nếu chưa có. Nên dùng một browser profile riêng cho ví demo.
2. Mở MetaMask và hoàn tất thiết lập ví theo màn hình. Chỉ lưu thông tin phục hồi ở nơi riêng của bạn.
3. Ở terminal Hardhat, tìm các mục **Account #0**, **Account #1**, **Account #2**. Bạn có thể cuộn lên đầu terminal.
4. Trong MetaMask, mở danh sách tài khoản → thêm ví/tài khoản → nhập bằng **private key**. Tên menu có thể là `Add wallet`, `Import a wallet` rồi chọn phương thức private key, tùy phiên bản. Nhập từng **khóa thử nghiệm Hardhat** và đặt tên theo bảng dưới.
5. Không gửi private key hoặc cụm từ phục hồi vào ChatGPT, dashboard hay báo cáo. Dashboard chỉ yêu cầu kết nối và xác nhận giao dịch trong extension.

| Hardhat | Tên gợi ý trong MetaMask | Địa chỉ mặc định |
| --- | --- | --- |
| Account #0 | Solar Điều phối | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` |
| Account #1 | Solar Nhà 1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| Account #2 | Solar Nhà 2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| Account #3, tùy chọn | Solar Nhà 3 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` |

Đối chiếu thêm bảng **Hướng dẫn** trong dashboard vì bảng đó đọc manifest triển khai hiện tại. Ví mới do MetaMask tự tạo sẽ không tự trở thành một hộ đã đăng ký trong hợp đồng.

Quay lại dashboard:

1. Bấm **Kết nối MetaMask**, cho phép kết nối các tài khoản demo sẽ dùng.
2. Chọn **Solar Điều phối** trong MetaMask.
3. Nếu dashboard báo sai mạng, bấm **Chuyển sang Solar Local**, xác nhận thêm/chuyển mạng trong MetaMask.
4. Kiểm tra góc trên phải hiện `Điều phối · 0xf39F…2266` và trạng thái “Ví đúng mạng local”.

Thông số mạng mặc định, nếu cần nhập thủ công:

| Trường | Giá trị |
| --- | --- |
| Tên mạng | Solar Local · Hardhat |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Ký hiệu tiền gas | `ETH` |
| Block explorer | Để trống |

ETH ở đây là ETH thử nghiệm được Hardhat cấp, không cần mua hoặc chuyển tiền thật. SLC có thể chưa hiện trong danh sách token của MetaMask; dashboard vẫn đọc được số dư trực tiếp. Nếu muốn thêm token vào ví, dùng địa chỉ `token` trong `/ui/status`, ký hiệu `SLC`, decimals `6`.

Hướng dẫn chính thức về nhập tài khoản: https://support.metamask.io/start/use-an-existing-wallet/

## 5. Lượt giao dịch đầu tiên: 2 lệnh → 1 giao dịch khớp

### A. Điều phối mở phiên

1. Vào **Thị trường**.
2. Chọn lượt có các đề xuất Phase 2. Lượt 864 số đo / 277 dự báo của bạn dùng được.
3. Giữ chế độ **Replay — kiểm thử bằng lịch sử**.
4. Chọn một đề xuất Mua/Bán chưa được dùng. Đề xuất đã thực hiện trong Phase 3 không thể tạo lại phiên bằng một chế độ khác.
5. Bấm **Chuẩn bị nguồn**. Gateway đọc lại dự báo và số đo gốc từ backend, kiểm tra liên kết rồi lưu bằng chứng.
6. Chọn **10 phút** nếu lần đầu thao tác; các lượt sau có thể dùng 5 hoặc 2 phút.
7. Với ví **Điều phối**, bấm **Mở phiên bằng ví Điều phối** rồi xác nhận trong MetaMask.
8. Đợi thông báo đã mở phiên và thấy **Phiên #N**. Số N có thể là 22 hoặc lớn hơn nếu đang dùng node Phase 3; không bắt buộc là #1.

Nếu dashboard báo nguồn đã có phiên, chọn/tiếp tục phiên đó. Nếu nguồn đã được dùng hoặc hủy, chọn đề xuất khác. Mỗi ví chỉ đặt được một lệnh trong một phiên; hủy không trả lại quyền dùng nguồn.

### B. Nhà 1 gửi lệnh dự báo ESP32

1. Đổi MetaMask sang **Solar Nhà 1**.
2. Đợi góc phải dashboard hiện `Nhà 1`. Nếu vẫn hiện ví cũ, kiểm tra quyền kết nối của site trong MetaMask rồi bấm lại nút kết nối trên dashboard.
3. Khung đặt lệnh lấy chiều Mua/Bán và lượng kWh từ đề xuất. Bạn chỉ chọn giá.
4. Dùng giá mặc định để thử: Nhà 1 **Bán giá 2 SLC/kWh**, hoặc **Mua giá 3 SLC/kWh**.
5. Bấm **Xem lại lệnh**. Kiểm tra phiên, ví, năng lượng, giá và lượng SLC sẽ khóa.
6. Bấm **Ký và gửi lệnh**.
7. Nếu là Mua, MetaMask có thể hỏi hai giao dịch: `approve` số SLC cần dùng, rồi `placeOrder`. Nếu còn hạn mức khác từ trước, có thêm bước `approve(0)` để xóa hạn mức cũ.
8. Đợi sổ lệnh hiện **1 lệnh trong phiên**.

Ô nhập dùng dấu chấm, ví dụ `0.100` hoặc `2.500`. Giao diện hiển thị theo định dạng Việt Nam, nhưng đầu vào không nhận `0,100`. Độ phân giải năng lượng 1 Wh = 0,001 kWh. Phần lẻ nhỏ hơn 1 Wh trong đề xuất bị làm tròn xuống.

### C. Nhà 2 đặt lệnh đối ứng

1. Đổi MetaMask sang **Solar Nhà 2** và chờ góc phải dashboard cập nhật.
2. Chọn chiều đối ứng, cùng lượng kWh với Nhà 1. Giá và lượng mặc định đã gợi ý đối ứng từ nguồn của phiên.

| Lệnh Nhà 1 | Lệnh Nhà 2 để thử khớp |
| --- | --- |
| Bán 0,100 kWh, giá 2 SLC/kWh | Mua 0,100 kWh, giá 3 SLC/kWh |
| Mua 0,100 kWh, giá 3 SLC/kWh | Bán 0,100 kWh, giá 2 SLC/kWh |

3. Bấm **Xem lại lệnh**, kiểm tra rồi **Ký và gửi lệnh**.
4. Nếu mua, xác nhận cấp quyền SLC và gửi lệnh trong MetaMask.
5. Đợi sổ lệnh hiện **2 lệnh trong phiên**.

Lệnh của Nhà 2 được gắn nhãn **Mô phỏng nhập tay**, không được gọi là dự báo AI. Nhà 3 cũng có thể tham gia; để kiểm tra lần đầu chỉ cần hai nhà như trên.

### D. Kết toán

1. Chờ bộ đếm của phiên về 0. Đây là ước tính theo đồng hồ chain; hợp đồng kiểm tra hạn cuối cùng.
2. Bấm **Kết toán phiên**. Có thể dùng ví Nhà 2 đang kết nối; không cần quay lại Điều phối.
3. Xác nhận giao dịch `settle` trong MetaMask.
4. Đợi **Đã khớp 1 giao dịch**.
5. Bấm **Xuất báo cáo JSON**. Một bản tải về trình duyệt; một bản lưu tại:

```text
data/phase3/reports/<deployment_id>/<round_id>.json
```

Với ví dụ 0,100 kWh, giá bán 2 và giá mua 3:

- Bên mua khóa tối đa 0,300 SLC khi đặt lệnh.
- Khi khớp hết, bên bán nhận 0,200 SLC theo **giá bán**.
- Bên mua được hoàn 0,100 SLC dư.
- Tổng SLC của ba nhà trở lại bằng trước phiên; chỉ phân phối khác nhau.
- SLC khóa riêng của các lệnh phiên này bằng 0. Tổng SLC tại thị trường chỉ bằng 0 nếu không có phiên khác còn giữ tiền.

Giao diện không tự tăng tốc đồng hồ blockchain và không tự kết toán. Dù bạn đóng trình duyệt, lệnh đã ký vẫn nằm trên chain; mở lại để tiếp tục hoặc dùng lệnh khôi phục Phase 3 ở mục 8.

## 6. Xem và kiểm chứng giao dịch

Vào **Giao dịch** → chọn phiên → bấm mã giao dịch hoặc **Xem ↗**.

Màn hình biên nhận hiển thị:

- receipt status 1/0;
- hàm đã gọi, ví gửi, hợp đồng nhận, số khối, gas;
- sự kiện đã giải mã, ví dụ `OrderPlaced`, `TradeExecuted`, `Refunded`, `RoundSettled`;
- chain 31337 và triển khai hiện tại.

Hardhat local không có Etherscan. Việc thiếu link Etherscan ở đây là đúng; một link chỉ có ý nghĩa khi triển khai lên một mạng công khai có explorer tương ứng.

Trong PowerShell có thể kiểm tra chéo:

```powershell
npm.cmd run market:report
```

Tìm đúng `ROUND N` vừa tạo. Kỳ vọng cho lượt hai lệnh:

```text
settled=true
orders=2
trades=1
source_hash_ok=true
status=1
```

Các phiên Phase 3 vẫn hiện trong báo cáo, nên tổng `rounds/trades` có thể lớn hơn lượt mới. Trong file JSON, kiểm tra `round_id`, `deployment_id`, `proposal_id`, `source_hash_verified`, `orders`, `trades`, `settlement`.

`source_hash_verified` đối chiếu hash dữ liệu nguồn của Nhà 1. Nó không chứng minh thiết bị thật là người gửi MQTT, không xác nhận tính đúng đắn của AI, và không xác nhận điện đã được giao vật lý. Báo cáo đánh dấu `energy_delivery_verified: false`.

## 7. Các tình huống cần thử thêm

**Hủy lệnh mua:** tạo phiên khác bằng đề xuất chưa dùng, đặt lệnh mua, bấm Hủy lệnh trước hạn. Lệnh chuyển Đã hủy, SLC khóa được hoàn. Ví đó không thể đặt lại trong cùng phiên. Có thể kết toán phiên rỗng sau hạn.

**Từ chối trong ví:** bấm Reject/Cancel ở MetaMask. Dashboard báo từ chối. Giao dịch bị từ chối chưa được gửi; những giao dịch bạn đã xác nhận trước đó vẫn tồn tại. Ví dụ đã `approve` rồi từ chối `placeOrder` thì chưa có lệnh và chưa khóa SLC ở thị trường, nhưng hạn mức ERC20 vẫn còn. Lần thử sau giao diện kiểm tra lại hạn mức.

**Đổi tài khoản/mạng trong khi đang cấp quyền:** giao diện dừng bước đặt lệnh nếu ngữ cảnh ví thay đổi. Chọn lại đúng ví/mạng, xem lại lệnh rồi thử lại.

**Không có giá phù hợp:** nếu giá mua thấp hơn giá bán, kết toán có thể có 0 giao dịch và hoàn toàn bộ tiền mua. Đây là kết quả thị trường hợp lệ.

**Live, tùy chọn sau khi Replay đạt:** cần backend/MQTT/ESP32 hoạt động, simulator đang running và đề xuất còn hiệu lực. Chế độ Live kiểm tra lại cả trước mở phiên và trước đặt lệnh. Nếu simulator đã gửi số đo cho khoảng dự báo đích, đề xuất trở thành observed/expired và không được dùng để mở/gửi lệnh Live nữa. Phiên đã mở vẫn có thể kết toán/hoàn tiền sau hạn.

Simulator chạy nhanh 5 hoặc 15 giây/khoảng thường không đủ thời gian thao tác nhiều hộ bằng tay. Nếu muốn thử Live thủ công, có thể chạy backend với `--stale-seconds 180` và simulator với `--interval 120`; giữ những điều kiện kiểm tra độ mới khác. Phải đợi đủ cửa sổ 12 số đo liên tục của ESP32; với 120 giây/khoảng, thời gian làm ấm khoảng 22–24 phút. Chỉ chọn Live khi sẵn sàng thao tác ví ngay, không đổi sang Live để tái sử dụng lịch sử.

## 8. Khởi động lại và xử lý lỗi

| Hiện tượng | Cách xử lý |
| --- | --- |
| Không mở được 5173 | Chạy `npm.cmd run dashboard`; giữ terminal này mở |
| Chưa có giao diện đã build | Chạy `npm.cmd run dashboard:build`, tải lại |
| Backend không kết nối | Chạy đúng `.venv-backend` trên cổng 8000; dữ liệu SQLite phải nằm ở dự án đang dùng |
| Hardhat chưa sẵn sàng | Kiểm tra terminal chain cổng 8545 và chạy `npm.cmd run deploy` |
| Triển khai/RPC không khớp | Kiểm tra MetaMask đang trỏ đúng 127.0.0.1:8545; chạy deploy khi node đã reset rồi tải lại |
| `writer_busy: true` | Dừng `market:live`, `demo:backend` hoặc tác vụ Phase 3 đang giữ writer lock; không xóa lock khi tiến trình còn chạy |
| EADDRINUSE | Cổng đang có tiến trình dùng. Dùng terminal đang chạy, không mở bản thứ hai |
| Sai tài khoản / Unauthorized | Đối chiếu ví thử nghiệm với bảng Hướng dẫn; ví Điều phối chỉ mở phiên, ví Nhà 1/2/3 đặt lệnh |
| Không thấy đề xuất | Chọn lượt đã có dự báo, dùng Replay; nếu đã dùng hết đề xuất thì tạo lượt simulator mới |
| Source đã dùng / Duplicate | Chọn đề xuất khác; hủy lệnh không mở lại quyền dùng nguồn |
| TooEarly | Đợi thêm rồi kết toán; bộ đếm chỉ là ước tính |
| Closed | Phiên đã hết hạn; kết toán phiên đó và mở phiên khác bằng nguồn chưa dùng |
| Ví có yêu cầu chờ | Mở MetaMask, xử lý yêu cầu đang hiện; không bấm liên tục |
| Đã gửi tx nhưng chờ quá lâu | Kiểm tra mã tx và node; không tự gửi lặp khi chưa biết tx cũ đã được ghi hay chưa |
| Phiên trình duyệt hết hạn | Gateway vừa khởi động lại; tải lại trang để lấy phiên mới |
| MQTT ngoại tuyến khi Replay | Có thể đọc lịch sử và giao dịch Replay; muốn có dữ liệu mới thì khởi động broker/backend/ESP32 |

Nếu bỏ dở một phiên đã mở và muốn kết toán bằng CLI:

```powershell
npm.cmd run market:settle
npm.cmd run market:report
```

Dừng thao tác trên dashboard trong lúc chạy hai lệnh trên. CLI có thể chờ phiên Live đến hạn. Replay CLI có thể tăng tốc đồng hồ node local để tới hạn, nên chỉ dùng trong môi trường demo này.

Nếu vừa reset Hardhat mà MetaMask báo nonce quá cao/giao dịch pending cũ, trước tiên kiểm tra đúng RPC/triển khai và lịch sử giao dịch local. Không reset toàn bộ ví đang dùng cho tài sản thật. Tài liệu MetaMask về activity/nonce: https://support.metamask.io/configure/accounts/resetting-your-account-in-the-event-of-a-stuck-or-pending-transaction

## 9. Nghiệm thu Phase 4 trên máy của bạn

Hoàn thành khi có đủ bằng chứng sau:

1. Trang Tổng quan đọc được ba nhà, dự báo ESP32 Nhà 1 và đúng lượt dữ liệu.
2. MetaMask kết nối đúng mạng 31337 và các tài khoản thử nghiệm.
3. Một phiên mới có 2 lệnh đối ứng được bạn ký qua giao diện.
4. Kết toán có 1 giao dịch khớp, receipt status 1; tiền dư đã được hoàn.
5. Báo cáo JSON có `source_hash_verified: true` và `settled: true`.
6. Có ảnh trang Thị trường sau kết toán, ảnh receipt và file JSON của **chính lượt bạn chạy**.

Ảnh mẫu trong `docs/phase4-*.png` được chụp từ kiểm thử tự động với dữ liệu fixture và ví adapter. Đừng dùng các ảnh mẫu để khẳng định đã nghiệm thu board/MetaMask thật tại máy của bạn.

## 10. Kiểm thử dành cho người phát triển

Kiểm thử hợp đồng/bridge Phase 3:

```powershell
npm.cmd test
```

Kiểm thử Phase 4 mở node và backend fixture riêng ở cổng trống, dùng SQLite tạm, Chromium và ví EIP-1193 adapter. Nó không sử dụng ví thật, MQTT thật hay dữ liệu hiện tại của bạn:

```powershell
.\.venv-backend\Scripts\python.exe -m pip install -r backend\requirements.txt
npx.cmd playwright install chromium
npm.cmd run test:phase4
```

Mặc định lấy Python từ `.venv-backend\Scripts\python.exe`. Nếu môi trường ở nơi khác:

```powershell
$env:SOLAR_TEST_PYTHON = "C:\duong-dan\python.exe"
npm.cmd run test:phase4
```

Kỳ vọng kết thúc bằng `PHASE 4 PASS`. Chi tiết kiểm thử đã thực hiện trong bản bàn giao: [PHASE4_VALIDATION.md](PHASE4_VALIDATION.md).

## 11. Bố cục mã và phạm vi

| File | Vai trò |
| --- | --- |
| `dashboard/src/App.jsx` | Bốn trang: Tổng quan, Thị trường, Giao dịch, Hướng dẫn |
| `dashboard/src/wallet.mjs` | EIP-6963, EIP-1193, Ethers BrowserProvider, bảo vệ tài khoản/mạng/nguồn, ký giao dịch |
| `dashboard/src/style.css` | Giao diện desktop và mobile |
| `dashboard/server.mjs` | Gateway bind 127.0.0.1, proxy GET backend, đọc chain, chuẩn bị/lưu bằng chứng |
| `dashboard/tests/` | Test đơn vị và trình duyệt với node thật, SQLite tạm |
| `blockchain/lib/market.mjs` | Dùng chung báo cáo Phase 3; thêm tùy chọn đọc snapshot không ghi file |

Gateway không nhận khóa riêng, không lấy signer và không có endpoint gửi giao dịch thay người dùng. Các POST chỉ chuẩn bị dữ liệu và lưu báo cáo; kiểm tra Origin và session token để chặn yêu cầu từ site khác. Đây là ứng dụng local cho đồ án, không phải hệ thống đa người dùng đã có đăng nhập/phân quyền máy chủ.

Hợp đồng có cùng ABI/bytecode với Phase 3. Danh sách hộ được cố định khi triển khai. Các quyền và giới hạn cuối cùng vẫn nằm ở hợp đồng; giao diện giúp chuẩn bị dữ liệu nhưng không thay thế xác thực nguồn MQTT hoặc xác minh giao điện thực tế.

Chưa có triển khai public testnet, Etherscan verification, xác nhận công tơ thật, thanh toán tiền thật, hay mô hình AI riêng cho Nhà 2/3. Những phần đó là hướng mở rộng sau nghiệm thu local.

Tài liệu kỹ thuật tham khảo: [Ethers v6](https://docs.ethers.org/v6/getting-started/), [Vite](https://vite.dev/guide/), [EIP-6963](https://eips.ethereum.org/EIPS/eip-6963), [EIP-3326](https://eips.ethereum.org/EIPS/eip-3326).
