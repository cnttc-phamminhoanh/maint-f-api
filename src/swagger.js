const p = {
  userId: { name: 'userId', in: 'query', required: true, schema: { type: 'string' }, description: 'ID người dùng (id số hoặc MNV). Có token phiên rồi thì server tự ghi đè trường này theo chủ phiên — truyền gì cũng được' },
  idParam: { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'ID thiết bị (id số trong eqm_mnt)' },
  qr: { name: 'qr', in: 'query', required: true, schema: { type: 'string' }, description: 'Mã thiết bị quét được (khớp chính xác tuyệt đối)' },
  page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  pageSize30: { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
};

const ok = (desc) => ({ 200: { description: desc } });
const okSchema = (schema) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } } });
const bad = { 400: { description: 'Dữ liệu đầu vào không hợp lệ (Joi)' } };
const err = {
  401: { description: 'Sai PIN / xác thực thất bại' },
  403: { description: 'Không có quyền (khác bộ phận / không phải người duyệt)' },
  404: { description: 'Không tìm thấy' },
  409: { description: 'Xung đột trạng thái' },
};

const deviceRecord = {
  type: 'object',
  description: 'Thông tin thiết bị (API giữ tên trường cũ: code/name/startDate/lastMaintenanceDate/maintenanceCycle/factory). Ngày đến hạn bảo trì do client tự tính từ startDate/lastMaintenanceDate/maintenanceCycle — API không trả về.',
  properties: {
    id: { type: 'string' },
    code: { type: 'string', description: 'Mã thiết bị (equ_no)' },
    name: { type: 'string' },
    startDate: { type: 'string', description: 'Ngày đưa vào sử dụng (YYYY-MM-DD)' },
    lastMaintenanceDate: { type: 'string', nullable: true },
    maintenanceCycle: { type: 'string', enum: ['1_week', '2_weeks', '1_month', '1_year'] },
    maintenanceStatus: { type: 'string', enum: ['needs_maintenance', 'in_maintenance', 'pending_approval', 'rejected', 'not_due'] },
    maintainer: { type: 'object', nullable: true, description: 'Người phụ trách hiệu lực (temp trong ngày ?? chính): { userId, empNo, empName }' },
    manager: { type: 'object', nullable: true, description: 'Người quản lý thiết bị (chủ sở hữu / approver): { userId, empNo, empName }' },
    maintenanceBy: { type: 'object', nullable: true, description: 'NV đang bảo dưỡng — chỉ có khi trạng thái in_maintenance/pending_approval/rejected: { userId, empNo, empName }' },
    requestedAt: { type: 'string', nullable: true, description: 'Thời điểm gửi xét duyệt (ISO)' },
    isTemporaryHandover: { type: 'boolean' },
    rejectionReason: { type: 'string', nullable: true },
    factory: { type: 'string', nullable: true, description: 'Phân xưởng (equ_addr)' },
    equType: { type: 'string', nullable: true },
    equTypeDesc: { type: 'string', nullable: true },
  },
};

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'API Quản lý Bảo dưỡng Thiết bị',
    version: '1.0.0',
    description: [
      'API standalone',
      '',
      '- Toàn bộ dữ liệu đầu vào được được kiểm tra (sai → HTTP 400 kèm thông báo chi tiết).',
      '- Đăng nhập bằng MNV (emp_no) + PIN — nhân viên chỉ cần nhớ mã nhân viên',
      '- Đăng nhập thành công trả token; các route nghiệp vụ mang header Authorization: Bearer <token>.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'Server hiện tại' }],
  tags: [
    { name: 'Auth', description: 'Đăng nhập PIN, hồ sơ cá nhân' },
    { name: 'Devices', description: 'Thiết bị: danh sách, quét mã, trạng thái, xét duyệt, chuyển xưởng, hoàn tác' },
    { name: 'Maintenance Orders', description: 'Hạng mục bảo dưỡng chuẩn & đơn bảo dưỡng theo thiết bị' },
    { name: 'Delayed Devices', description: 'Thiết bị trễ hạn (chỉ admin) + đồng bộ' },
    { name: 'Statistics', description: 'Thống kê BI công khai' },
  ],
  paths: {
    // ================= AUTH =================
    '/api/auth/user/lookup': {
      get: {
        tags: ['Auth'],
        summary: 'Tra cứu nhân viên theo MNV',
        parameters: [{ name: 'empNo', in: 'query', required: true, schema: { type: 'string' }, description: 'Mã nhân viên (MNV)' }],
        responses: okSchema({
          type: 'object',
          properties: {
            exists: { type: 'boolean' },
            userId: { type: 'string' },
            empName: { type: 'string' },
            position: { type: 'string' },
            registered: { type: 'boolean', description: 'Đã đăng ký (đặt PIN) hay chưa' },
          },
        }),
      },
    },
    '/api/auth/user/status': {
      get: {
        tags: ['Auth'],
        summary: 'Trạng thái tài khoản (PIN)',
        parameters: [{ name: 'empNo', in: 'query', required: true, schema: { type: 'string' }, description: 'Mã nhân viên (MNV)' }],
        responses: okSchema({
          type: 'object',
          properties: {
            userId: { type: 'string' },
            empNo: { type: 'string' },
            empName: { type: 'string' },
            position: { type: 'string' },
            avatarUrl: { type: 'string', nullable: true },
            hasPin: { type: 'boolean' }
          },
        }),
      },
    },
    '/api/auth/user/register': {
      post: {
        tags: ['Auth'],
        summary: 'Đăng ký tài khoản lần đầu theo MNV',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['empNo', 'accessPassword'],
                properties: {
                  empNo: { type: 'string', minLength: 2, maxLength: 100 },
                  empName: { type: 'string', maxLength: 200 },
                  accessPassword: { type: 'string', description: 'Mật khẩu mở đăng ký (REGISTER_PASSWORD). Bắt buộc — server kiểm tra để chống đăng ký hàng loạt' },
                },
              },
            },
          },
        },
        responses: {
          ...ok('userId của tài khoản'),
          403: { description: 'Sai hoặc thiếu mật khẩu mở đăng ký' },
          409: { description: 'Đã đăng ký' },
          429: { description: 'REGISTER_LOCKED — vượt giới hạn số lần đăng ký trong cửa sổ thời gian' },
        },
      },
    },
    '/api/auth/user/profile': {
      post: {
        tags: ['Auth'],
        summary: 'Cập nhật tên hiển thị / ảnh đại diện',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['empNo', 'empName'],
                properties: { empNo: { type: 'string', description: 'Mã nhân viên (MNV)' }, empName: { type: 'string', maxLength: 200 }, avatarUrl: { type: 'string', maxLength: 2048 } },
              },
            },
          },
        },
        responses: { ...ok('success'), ...{ 404: err[404] } },
      },
    },
    '/api/auth/pin/setup': {
      post: {
        tags: ['Auth'],
        summary: 'Đặt PIN lần đầu (≥ 4 ký tự, băm scrypt)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['empNo', 'pin'], properties: { empNo: { type: 'string', description: 'Mã nhân viên (MNV)' }, pin: { type: 'string', minLength: 4 } } } } },
        },
        responses: { ...ok('success'), ...bad, 404: err[404], 409: { description: 'Đã có PIN' } },
      },
    },
    '/api/auth/pin/verify': {
      post: {
        tags: ['Auth'],
        summary: 'Đăng nhập bằng MNV + PIN — trả token phiên',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['empNo', 'pin'], properties: { empNo: { type: 'string', description: 'Mã nhân viên (MNV)' }, pin: { type: 'string' } } } } },
        },
        responses: okSchema({
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            token: { type: 'string', description: 'Token phiên (mang theo header Authorization: Bearer)' },
            expiresAt: { type: 'string', format: 'date-time' },
            userId: { type: 'string', description: 'id nội bộ (dùng cho các route nghiệp vụ)' },
            empNo: { type: 'string' },
            empName: { type: 'string' },
          },
        }),
      },
    },
    '/api/auth/pin/change': {
      post: {
        tags: ['Auth'],
        summary: 'Đổi PIN (yêu cầu PIN hiện tại đúng)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['empNo', 'currentPin', 'newPin'], properties: { empNo: { type: 'string', description: 'Mã nhân viên (MNV)' }, currentPin: { type: 'string' }, newPin: { type: 'string', minLength: 4 } } } } },
        },
        responses: { ...ok('success'), 401: { description: 'WRONG_CURRENT_PIN' } },
      },
    },
    '/api/auth/register-access': {
      post: {
        tags: ['Auth'],
        summary: 'Kiểm tra mật khẩu cho phép mở đăng ký',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['password'], properties: { password: { type: 'string' } } } } } },
        responses: okSchema({ type: 'object', properties: { allowed: { type: 'boolean' } } }),
      },
    },

    // ================= DEVICES =================
    '/api/devices': {
      get: {
        tags: ['Devices'],
        summary: 'Danh sách thiết bị (phân quyền theo userId)',
        description: 'scope=mine: chỉ thiết bị mình phụ trách; scope=department: toàn bộ bộ phận. KHÔNG truyền scope = tầm nhìn trang chủ FE: nhân viên / chủ quản / văn thư thấy toàn bộ thiết bị bộ phận mình, admin thấy tất cả, approver thấy yêu cầu pending của mình. Sắp xếp theo ưu tiên trạng thái hiển thị.',
        parameters: [
          p.userId,
          { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Tìm theo mã / tên / người phụ trách' },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['needs_maintenance', 'in_maintenance', 'pending_approval', 'rejected', 'not_due'] } },
          { name: 'due', in: 'query', schema: { type: 'string', enum: ['all', 'overdue', 'today', 'tomorrow', 'later'] } },
          { name: 'cycle', in: 'query', schema: { type: 'string', enum: ['1_week', '2_weeks', '1_month', '1_year'] } },
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['mine', 'department'] } },
          p.page,
          p.pageSize30,
        ],
        responses: okSchema({
          type: 'object',
          properties: {
            items: { type: 'array', items: deviceRecord },
            position: { type: 'string', description: 'Chức vụ người gọi (FE dùng để bật chế độ approver/admin)' },
            showMaintainer: { type: 'boolean', description: 'Có hiển thị dòng "Người phụ trách" trên card hay không' },
            total: { type: 'integer' },
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            statusCounts: { type: 'object', description: 'Số thiết bị theo trạng thái hiển thị' },
            cycleCounts: { type: 'object', description: 'Số thiết bị theo chu kỳ' },
            dueCounts: { type: 'object', description: 'Số thiết bị theo mốc hạn (all/overdue/today/tomorrow/later)' },
          },
        }),
      },
    },
    '/api/devices/by-qr': {
      get: {
        tags: ['Devices'],
        summary: 'Tra thiết bị theo mã QR (chính xác tuyệt đối)',
        description: 'Không có bất kỳ cơ chế sửa lỗi / bù số nào — sai 1 ký tự cũng trả 404. Truyền userId để kiểm tra quyền bộ phận (khác bộ phận → 403).',
        parameters: [p.qr, { ...p.userId, required: false, description: 'Tùy chọn — truyền để kiểm tra quyền bộ phận' }],
        responses: { ...okSchema(deviceRecord), 403: err[403], 404: err[404] },
      },
    },
    '/api/devices/managed': {
      get: {
        tags: ['Devices'],
        summary: 'Thiết bị do tôi quản lý (chỉ approver)',
        description: 'Chỉ chức vụ approver được gọi; vị trí khác (kể cả admin) trả 403.',
        parameters: [p.userId, { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['due', 'name'], default: 'due' } }, p.page, p.pageSize30],
        responses: okSchema({ type: 'object', properties: { items: { type: 'array', items: deviceRecord }, total: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer' } } }),
      },
    },
    '/api/devices/factories': {
      get: {
        tags: ['Devices'],
        summary: 'Danh sách phân xưởng (approver có equ_addr)',
        parameters: [p.userId],
        responses: ok('Danh sách { value, label, approverName }'),
      },
    },
    '/api/devices/maintainer-candidates': {
      get: {
        tags: ['Devices'],
        summary: 'Ứng viên người phụ trách mới (chỉ cùng bộ phận với người gọi, admin thấy tất cả)',
        parameters: [p.userId],
        responses: ok('Danh sách { id, empNo, empName, position }'),
      },
    },
    '/api/devices/{id}': {
      get: {
        tags: ['Devices'],
        summary: 'Chi tiết thiết bị theo id',
        parameters: [p.idParam],
        responses: { ...okSchema(deviceRecord), 404: err[404] },
      },
    },
    '/api/devices/{id}/status': {
      patch: {
        tags: ['Devices'],
        summary: 'Cập nhật trạng thái (bắt đầu bảo dưỡng / hoàn tác trạng thái)',
        description: 'Người không phải phụ trách chính khi đặt in_maintenance sẽ được ghi nhận là người bảo dưỡng tạm thời trong ngày (temp_maintainer).',
        parameters: [p.idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['status', 'userId'], properties: { status: { type: 'string', enum: ['needs_maintenance', 'in_maintenance', 'pending_approval', 'rejected', 'not_due'] }, userId: { type: 'string' } } },
            },
          },
        },
        responses: { ...okSchema({ type: 'object', properties: { success: { type: 'boolean' } } }), ...bad, 403: err[403], 404: err[404], 409: { description: 'Thiết bị đang được người khác bảo dưỡng' } },
      },
    },
    '/api/devices/{id}/submit-approval': {
      post: {
        tags: ['Devices'],
        summary: 'Gửi xét duyệt hoàn thành (kèm hạng mục đã chọn)',
        description: 'Với in_maintenance bắt buộc phải có itemIds và thiết bị phải có equ_type; với rejected có thể gửi lại itemIds mới hoặc dùng hạng mục đã lưu. Phải có ít nhất 1 hạng mục, nếu không trả 400. Đơn bảo dưỡng chỉ được tạo khi approver xác nhận.',
        parameters: [p.idParam],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' }, itemIds: { type: 'array', items: { type: 'string' }, description: 'fitNo của hạng mục đã chọn' } } } } },
        },
        responses: { ...okSchema({ type: 'object', properties: { success: { type: 'boolean' } } }), ...bad, 403: err[403], 404: err[404] },
      },
    },
    '/api/devices/{id}/approve-completion': {
      post: {
        tags: ['Devices'],
        summary: 'Approver xác nhận hoàn thành → tạo đơn bảo dưỡng (sheet_no)',
        parameters: [p.idParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } } } } },
        responses: { ...okSchema({ type: 'object', properties: { success: { type: 'boolean' } } }), 400: err[400], 403: err[403], 404: err[404] },
      },
    },
    '/api/devices/{id}/reject-completion': {
      post: {
        tags: ['Devices'],
        summary: 'Approver từ chối hoàn thành (kèm lý do)',
        description: 'Chỉ chủ sở hữu thiết bị được từ chối. Không thay đổi người phụ trách; hạng mục đã chọn được giữ lại để gửi lại.',
        parameters: [p.idParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' }, reason: { type: 'string', maxLength: 500 } } } } } },
        responses: { ...okSchema({ type: 'object', properties: { success: { type: 'boolean' } } }), 403: err[403], 404: err[404] },
      },
    },
    '/api/devices/bulk-approve-completion': {
      post: {
        tags: ['Devices'],
        summary: 'Xác nhận hàng loạt (approver)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['ids', 'userId'], properties: { ids: { type: 'array', items: { type: 'string' } }, userId: { type: 'string' } } } } },
        },
        responses: { ...okSchema({ type: 'object', properties: { success: { type: 'boolean' }, processed: { type: 'integer', description: 'Số thiết bị pending thuộc quyền người gọi đã xác nhận' } } }), ...bad },
      },
    },
    '/api/devices/bulk-reject-completion': {
      post: {
        tags: ['Devices'],
        summary: 'Từ chối hàng loạt (approver)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['ids', 'userId'], properties: { ids: { type: 'array', items: { type: 'string' } }, userId: { type: 'string' }, reason: { type: 'string' } } } } },
        },
        responses: { ...okSchema({ type: 'object', properties: { success: { type: 'boolean' }, processed: { type: 'integer', description: 'Số thiết bị pending thuộc quyền người gọi đã từ chối' } } }), ...bad },
      },
    },
    '/api/devices/{id}/undo-maintenance': {
      post: {
        tags: ['Devices'],
        summary: 'Hoàn tác bảo dưỡng (in_maintenance / rejected)',
        description: 'Chỉ người đang bảo dưỡng hoặc chủ quản / văn thư của bộ phận thiết bị được thực hiện. Trạng thái tính lại theo thời hạn, không đổi lịch bảo dưỡng.',
        parameters: [p.idParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } } } } },
        responses: { ...okSchema({ type: 'object', properties: { success: { type: 'boolean' }, newStatus: { type: 'string', description: 'Trạng thái tính lại: needs_maintenance / not_due' } } }), 400: err[400], 403: err[403], 404: err[404] },
      },
    },
    '/api/devices/{id}/transfer-factory': {
      post: {
        tags: ['Devices'],
        summary: 'Chuyển phân xưởng (đổi approver + xưởng, kèm người phụ trách mới)',
        parameters: [p.idParam],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['userId', 'targetFactory'], properties: { userId: { type: 'string' }, targetFactory: { type: 'string', description: 'Mã xưởng đích (F1..F5)' }, newMaintainerId: { type: 'string', nullable: true, description: 'MNV người phụ trách mới (bắt buộc chọn ở FE)' } } },
            },
          },
        },
        responses: { ...okSchema({ type: 'object', properties: { success: { type: 'boolean' }, device: deviceRecord } }), ...bad, 403: err[403], 404: err[404] },
      },
    },

    // ================= MAINTENANCE ORDERS =================
    '/api/maintenance-orders/templates': {
      get: {
        tags: ['Maintenance Orders'],
        summary: 'Hạng mục bảo dưỡng chuẩn theo loại thiết bị',
        description: 'Lọc theo cột công tắc tương ứng mtFlag (1→wk1_sw, 2→wk2_sw, 3→mon_sw, 4→year_sw).',
        parameters: [
          { name: 'equType', in: 'query', required: true, schema: { type: 'string' }, description: 'Mã loại thiết bị' },
          { name: 'mtFlag', in: 'query', schema: { type: 'string', enum: ['1', '2', '3', '4'] }, description: 'Chu kỳ (không truyền = trả tất cả)' },
        ],
        responses: okSchema({
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, equType: { type: 'string' }, fitNo: { type: 'string' }, fitName: { type: 'string', nullable: true }, mtDesc: { type: 'string', nullable: true, description: 'Nhiều mô tả cùng fit_no ghép bằng " - "' }, wk1Sw: { type: 'string', enum: ['0', '1'] }, wk2Sw: { type: 'string', enum: ['0', '1'] }, monSw: { type: 'string', enum: ['0', '1'] }, yearSw: { type: 'string', enum: ['0', '1'] } } } } },
        }),
      },
    },
    '/api/maintenance-orders/device/{deviceId}': {
      get: {
        tags: ['Maintenance Orders'],
        summary: 'Danh sách đơn bảo dưỡng của thiết bị (kèm đầy đủ hạng mục từng đơn)',
        parameters: [{ name: 'deviceId', in: 'path', required: true, schema: { type: 'string' }, description: 'Mã thiết bị (equ_no)' }],
        responses: okSchema({
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object', properties: { sheetNo: { type: 'string' }, sheetDate: { type: 'string' }, empNo: { type: 'string', nullable: true }, checkEmpNo: { type: 'string', nullable: true }, items: { type: 'array', items: { type: 'object' } } } } },
            total: { type: 'integer' },
          },
        }),
      },
    },

    // ================= DELAYED DEVICES =================
    '/api/delayed-devices': {
      get: {
        tags: ['Delayed Devices'],
        summary: 'Danh sách thiết bị trễ hạn (chỉ admin)',
        parameters: [
          p.userId,
          { name: 'reason', in: 'query', schema: { type: 'string', enum: ['not_started', 'in_progress', 'awaiting_approval', 'rejected'] } },
          p.page,
          p.pageSize30,
        ],
        responses: {
          ...okSchema({
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'object' } },
              total: { type: 'integer' },
              page: { type: 'integer' },
              pageSize: { type: 'integer' },
              reasonCounts: { type: 'array', items: { type: 'object', properties: { reason: { type: 'string' }, count: { type: 'integer' } } } },
              lastSyncedAt: { type: 'string', nullable: true },
            },
          }),
          403: err[403],
        },
      },
    },
    '/api/delayed-devices/sync': {
      post: {
        tags: ['Delayed Devices'],
        summary: 'Đồng bộ lại bảng thiết bị trễ hạn (chỉ admin)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } } } } },
        responses: { ...okSchema({ type: 'object', properties: { total: { type: 'integer' }, syncedAt: { type: 'string' } } }), 403: err[403] },
      },
    },

    // ================= STATISTICS =================
    '/api/statistics/overview': {
      get: {
        tags: ['Statistics'],
        summary: 'Tổng quan BI (công khai)',
        responses: okSchema({
          type: 'object',
          properties: {
            totalDevices: { type: 'integer' },
            completedToday: { type: 'integer' },
            statusCounts: { type: 'array', items: { type: 'object', properties: { status: { type: 'string' }, count: { type: 'integer' } } } },
            cycleCounts: { type: 'array', items: { type: 'object', properties: { cycle: { type: 'string' }, count: { type: 'integer' } } } },
            departmentCounts: { type: 'array', items: { type: 'object' } },
            delayedTotal: { type: 'integer' },
            delayedByReason: { type: 'array', items: { type: 'object', properties: { reason: { type: 'string' }, count: { type: 'integer' } } } },
            lastSyncedAt: { type: 'string', nullable: true },
            departmentDueStats: { type: 'array', items: { type: 'object' } },
            cycleMaintStats: { type: 'array', items: { type: 'object' } },
          },
        }),
      },
    },
    '/api/statistics/delayed-devices': {
      get: {
        tags: ['Statistics'],
        summary: 'Thiết bị trễ hạn (trang BI công khai, không cần userId)',
        parameters: [
          { name: 'reason', in: 'query', schema: { type: 'string', enum: ['not_started', 'in_progress', 'awaiting_approval', 'rejected'] } },
          p.page,
          p.pageSize30,
        ],
        responses: ok('Cùng cấu trúc GET /api/delayed-devices'),
      },
    },
    '/api/statistics/equipment': {
      get: {
        tags: ['Statistics'],
        summary: 'Danh sách thiết bị trang BI (công khai, kèm danh mục lọc)',
        parameters: [
          { name: 'factory', in: 'query', schema: { type: 'string' }, description: 'Mã bộ phận (mnt_dept_no)' },
          { name: 'empNo', in: 'query', schema: { type: 'string' }, description: 'MNV người phụ trách' },
          { name: 'respEmpNo', in: 'query', schema: { type: 'string' }, description: 'MNV người chịu trách nhiệm (approver)' },
          { name: 'maintType', in: 'query', schema: { type: 'string', enum: ['1_week', '2_weeks', '1_month', '1_year'] } },
          { name: 'equNo', in: 'query', schema: { type: 'string' }, description: 'Tìm theo mã thiết bị (LIKE)' },
          p.page,
          { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: okSchema({
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            total: { type: 'integer' },
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
            factories: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } } },
            maintTypes: { type: 'array', items: { type: 'object' } },
            empOptions: { type: 'array', items: { type: 'object', properties: { empNo: { type: 'string' }, empName: { type: 'string' } } } },
            respOptions: { type: 'array', items: { type: 'object' } },
          },
        }),
      },
    },
  },
  components: {
    schemas: {
      Error: {
        type: 'object',
        properties: { message: { type: 'string' }, error: { type: 'string' }, statusCode: { type: 'integer' } },
      },
    },
    responses: {
      BadRequest: { description: 'Dữ liệu đầu vào không hợp lệ (Joi)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  },
};

module.exports = spec;
