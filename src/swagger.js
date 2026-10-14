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
        summary: 'Cập nhật tên hiển thị',
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
// Swagger / OpenAPI 3.0 spec cho local API (tieng Viet)
// Cap nhat 2026-10-14: bo sung holidays, xuongs, push, /devices/ids,
// statistics delay-history + completed-today; sua mo ta quyen duyet theo
// phan xuong (xuong_mnt), temp maintainer khong het han qua ngay,
// profile = PATCH, register-access = GET, token 30 ngay.
function buildSpec(baseUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'API bao tri thiet bi (local)',
      version: '1.2.0',
      description:
        'API bao tri thiet bi chay local, noi voi SQL Server cua ung dung. ' +
        'Mo phong dung hop dong voi backend NestJS cloud.\n\n' +
        '**Danh tinh**: moi request co token deu bi chot theo phien — truyen MNV/id cua nguoi khac bi tu choi (403 TOKEN_USER_MISMATCH).\n' +
        '**Luong duyet**: `approver_emp_no` tren thiet bi la MA PHAN XUONG; nhom duyet = chu quan + pho quan 1/2 trong `xuong_mnt` + chu quan/van thu bo phan thiet bi.',
    },
    servers: [{ url: baseUrl }],
    tags: [
      { name: 'auth', description: 'Dang nhap PIN, PIN, ho so ca nhan (face: endpoint con ton tai nhung FE khong dung)' },
      { name: 'devices', description: 'Thiet bi, bao duong, xet duyet, chuyen phan xuong' },
      { name: 'maintenance-orders', description: 'Hang muc bao duong chuan va don bao duong' },
      { name: 'delayed', description: 'Lich su tre han va dong bo (chi admin)' },
      { name: 'statistics', description: 'Cong khai, khong can dang nhap (BI dashboard)' },
      { name: 'holidays', description: 'Ngay nghi do bo phan HR khai bao' },
      { name: 'xuongs', description: 'Phan xuong va nhom duyet' },
      { name: 'push', description: 'Dang ky token push va quan tri thong bao' },
      { name: 'swagger', description: 'Mo ta API' },
    ],
    paths: {
      '/swagger.json': {
        get: {
          tags: ['swagger'],
          summary: 'OpenAPI 3.0 spec (JSON)',
          responses: { 200: { description: 'OpenAPI 3.0 spec' } },
        },
      },
      '/docs': {
        get: {
          tags: ['swagger'],
          summary: 'Trang Swagger UI',
          responses: { 200: { description: 'HTML' } },
        },
      },

      // ==== Statistics (public) ====
      '/api/statistics/overview': {
        get: {
          tags: ['statistics'],
          summary: 'Tong quan BI (cong khai)',
          description:
            'So lieu BI: so thiet bi theo trang thai (not_due/needs_maintenance/in_maintenance/pending_approval/rejected), ' +
            'dueToday, completedToday, total, danh sach thiet bi tre hien tai (doc truc tiep tu eqm_mnt, tinh luc doc) kem theo bo phan, ' +
            'thong ke lich su tre han theo bo phan, top 10 bo phan co tong so lan tre nhieu nhat, va thong ke so lan tre lich su theo bo phan x chu ky.',
          responses: { 200: { description: '{ delayed, byStatus, dueToday, completedToday, total, delayedItems, deptDelayed, ranking, delayedByReason, deptDelayHistory, delayedHistoryTotal, deptDelayCycleStats }' } },
        },
      },
      '/api/statistics/delayed-devices': {
        get: {
          tags: ['statistics'],
          summary: 'Danh sach thiet bi dang tre han (cong khai)',
          description:
            'Danh sach thiet bi hien dang tre han (doc truc tiep tu eqm_mnt va tinh luc doc), kem ten bo phan. Ho tro loc theo bo phan (dept) va phan trang (page, pageSize ≤ 100). Tra ve items, total, page, pageSize.',
          parameters: [
            { name: 'dept', in: 'query', schema: { type: 'string' }, description: 'Ma bo phan (tuy chon)' },
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          ],
          responses: { 200: { description: '{ items, total, page, pageSize }' } },
        },
      },
      '/api/statistics/equipment': {
        get: {
          tags: ['statistics'],
          summary: 'Danh sach thiet bi cho BI (cong khai)',
          description: 'Danh sach thiet bi day du cho BI dashboard, co phan trang (page, pageSize ≤ 100).',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          ],
          responses: { 200: { description: '{ items, total, page, pageSize }' } },
        },
      },
      '/api/statistics/delay-history': {
        get: {
          tags: ['statistics'],
          summary: 'Lich su tre han (cong khai)',
          description:
            'Toan bo episode trong eqm_mnt_delay (gom ca da ket thuc), moi nhat truoc. ' +
            'So ngay tre duoc tinh lai theo ngay hien tai cho episode con mo. Ho tro loc theo bo phan (dept) va phan trang.',
          parameters: [
            { name: 'dept', in: 'query', schema: { type: 'string' }, description: 'Ma bo phan (tuy chon)' },
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
          ],
          responses: { 200: { description: '{ items, total, page, pageSize }' } },
        },
      },
      '/api/statistics/completed-today': {
        get: {
          tags: ['statistics'],
          summary: 'So don hoan thanh trong ngay (cong khai)',
          description: 'So luong don bao duong (eqm_mt1) da duoc xac nhan hoan thanh trong ngay hien tai (gio kinh doanh VN).',
          responses: { 200: { description: '{ count }' } },
        },
      },

      // ==== Auth ====
      '/api/auth/user/lookup': {
        get: {
          tags: ['auth'],
          summary: 'Kiem tra MNV co ton tai khong',
          description:
            'Cong khai. Tra ve exists, da dat PIN, co anh khuon mat, co ho ten hay khac de giao dien hien thi buoc tiep theo.',
          parameters: [
            { name: 'empNo', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 100 } },
          ],
          responses: { 200: { description: '{ exists, hasPin, hasFace, hasName }' } },
        },
      },
      '/api/auth/user/status': {
        get: {
          tags: ['auth'],
          summary: 'Trang thai tai khoan theo MNV',
          description: 'Cong khai. Cho biet tai khoan ton tai khong, da dat PIN chua, co anh khuon mat khong, co ho ten khong.',
          parameters: [
            { name: 'empNo', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 100 } },
          ],
          responses: {
            200: { description: '{ exists, hasPin, hasFace, hasName }' },
            404: { description: 'MNV khong ton tai' },
          },
        },
      },
      '/api/auth/user/register': {
        post: {
          tags: ['auth'],
          summary: 'Dang ky tai khoan lan dau',
          description:
            'Cong khai. Tao tai khoan chua co PIN de vao man hinh thiet lap PIN. Bat buoc gui dung mat khua mo dang ky (accessPassword) — server kiem tra chu khong chi chan o giao dien. Qua 10 lan dang ky trong 15 phut se bi chan.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['empNo', 'accessPassword'],
                  properties: {
                    empNo: { type: 'string', minLength: 2, maxLength: 100 },
                    empName: { type: 'string', maxLength: 200, description: 'Ho ten (tuy chon)' },
                    accessPassword: { type: 'string', minLength: 1, maxLength: 200 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ user }' },
            401: { description: 'Sai mat khua dang ky' },
            409: { description: 'MNV da ton tai' },
            429: { description: 'Vuot gioi han dang ky' },
          },
        },
      },
      '/api/auth/user/profile': {
        patch: {
          tags: ['auth'],
          summary: 'Cap nhat ho so ca nhan',
          description:
            'Can token. Doi ten hien thi, anh dai dien, ma bo phan. empNo trong body phai trung voi nguoi dang nhap (neu khac se bi tu choi 403).',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['empNo', 'empName'],
                  properties: {
                    empNo: { type: 'string', minLength: 1, maxLength: 100 },
                    empName: { type: 'string', minLength: 1, maxLength: 200 },
                    avatarUrl: { type: 'string', maxLength: 2048 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success, user }' },
            401: { description: 'Chua dang nhap' },
            403: { description: 'Khong trung nguoi dang nhap' },
            404: { description: 'Nguoi dung khong ton tai' },
          },
        },
      },
      '/api/auth/logout': {
        post: {
          tags: ['auth'],
          summary: 'Dang xuat (huy phien hien tai)',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: '{ success }' },
            401: { description: 'Chua dang nhap' },
          },
        },
      },
      '/api/auth/pin/setup': {
        post: {
          tags: ['auth'],
          summary: 'Dat PIN lan dau',
          description: 'Cong khai. Chi cho phep khi tai khoan chua co PIN (da co PIN phai dung pin/change).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['empNo', 'pin'],
                  properties: {
                    empNo: { type: 'string', minLength: 1, maxLength: 100 },
                    pin: { type: 'string', minLength: 4, maxLength: 20 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success }' },
            400: { description: 'Da co PIN hoac chua co tai khoan' },
            404: { description: 'MNV khong ton tai' },
          },
        },
      },
      '/api/auth/pin/verify': {
        post: {
          tags: ['auth'],
          summary: 'Dang nhap bang PIN',
          description:
            'Cong khai. Sai PIN qua 5 lan se bi khoa 15 phut (429, errorCode ACCOUNT_LOCKED:<so phut con lai>). Thanh cong tra ve token (Bearer, hieu luc 30 ngay) va thong tin ca nhan.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['empNo', 'pin'],
                  properties: {
                    empNo: { type: 'string', minLength: 1, maxLength: 100 },
                    pin: { type: 'string', minLength: 1, maxLength: 20 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success, token, user }' },
            401: { description: 'Sai PIN (errorCode WRONG_PIN)' },
            404: { description: 'MNV khong ton tai' },
            423: { description: 'Chua dat PIN' },
            429: { description: 'Khoa tam thoi (ACCOUNT_LOCKED:<phut>)' },
          },
        },
      },
      '/api/auth/pin/change': {
        post: {
          tags: ['auth'],
          summary: 'Doi PIN',
          description: 'Can token. Yeu cau nhap dung PIN hien tai; sai tra ve errorCode WRONG_CURRENT_PIN. Sau khi doi se huy toan bo phien cu, phai dang nhap lai.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['empNo', 'currentPin', 'newPin'],
                  properties: {
                    empNo: { type: 'string', minLength: 1, maxLength: 100 },
                    currentPin: { type: 'string', minLength: 1, maxLength: 20 },
                    newPin: { type: 'string', minLength: 4, maxLength: 20 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success }' },
            401: { description: 'Chua dang nhap hoac sai PIN hien tai' },
            404: { description: 'MNV khong ton tai' },
            423: { description: 'Chua dat PIN' },
          },
        },
      },
      '/api/auth/face/register': {
        post: {
          tags: ['auth'],
          summary: 'Luu anh khuon mat (endpoint cu, FE khong con dung)',
          description: 'Can token. FE da bo luong dang nhap khuon mat (2026-10-02); endpoint giu lai cho nghien cuu.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['empNo', 'imageUrl'],
                  properties: {
                    empNo: { type: 'string', minLength: 1, maxLength: 100 },
                    imageUrl: { type: 'string', minLength: 1, maxLength: 2048 },
                    relaxClose: { type: 'boolean' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success }' },
            401: { description: 'Chua dang nhap' },
            403: { description: 'Khong trung nguoi dang nhap' },
            404: { description: 'MNV khong ton tai' },
            422: { description: 'Khong nhan dien duoc khuon mat' },
          },
        },
      },
      '/api/auth/face/verify': {
        post: {
          tags: ['auth'],
          summary: 'Dang nhap bang khuon mat (endpoint cu, FE khong con dung)',
          description: 'Cong khai. FE da bo luong nay; endpoint giu lai cho nghien cuu.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['empNo', 'imageUrl'],
                  properties: {
                    empNo: { type: 'string', minLength: 1, maxLength: 100 },
                    imageUrl: { type: 'string', minLength: 1, maxLength: 2048 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success, token, user }' },
            401: { description: 'Khong khuop khuon mat' },
            404: { description: 'MNV khong ton tai hoac chua dang ky khuon mat' },
          },
        },
      },
      '/api/auth/register-access': {
        get: {
          tags: ['auth'],
          summary: 'Kiem tra mat khua mo dang ky',
          description: 'Cong khai. Giao dien dung de hien loi mat khua truoc khi goi dang ky that.',
          parameters: [
            { name: 'password', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 200 } },
          ],
          responses: {
            200: { description: '{ allowed: true }' },
            401: { description: 'Sai mat khua mo dang ky' },
          },
        },
      },

      // ==== Devices ====
      '/api/devices': {
        get: {
          tags: ['devices'],
          summary: 'Danh sach thiet bi (theo vai tro)',
          description:
            'Can token. Khong truyen scope: nhan vien/chu quan/van thu thay thiet bi bo phan minh, admin thay tat ca, vi tri khac thay thiet bi cho minh duyet. ' +
            'approvalOnly=1 chi danh cho chu quan/van thu (thiet bi pending_approval cua bo phan minh). ' +
            'due=overdue loai thiet bi pending_approval (che do bao tri).',
          parameters: [
            { name: 'userId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Tim theo ma, ten, nguoi phu trach' },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['not_due', 'needs_maintenance', 'in_maintenance', 'pending_approval', 'rejected'] } },
            { name: 'due', in: 'query', schema: { type: 'string', enum: ['overdue', 'today', 'tomorrow', 'still_good'] } },
            { name: 'cycle', in: 'query', schema: { type: 'string', enum: ['1_week', '2_weeks', '1_month', '1_year'] } },
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
            { name: 'scope', in: 'query', schema: { type: 'string', enum: ['mine', 'department'] } },
            { name: 'approvalOnly', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'Chi lay thiet bi cho duyet cua bo phan (chu quan/van thu)' },
          ],
          responses: {
            200: { description: '{ items, total, page, pageSize, statusCounts, cycleCounts, dueCounts, position, showMaintainer }' },
            404: { description: 'userId khong ton tai' },
          },
        },
      },
      '/api/devices/ids': {
        get: {
          tags: ['devices'],
          summary: 'Danh sach id thiet bi theo bo loc (de "Chon tat ca")',
          description:
            'Can token. Cung bo loc nhu GET /api/devices (khong phan trang) nhung chi tra ve danh sach id — dung cho chon tat ca de duyet/tu choi hang loat.',
          parameters: [
            { name: 'userId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['not_due', 'needs_maintenance', 'in_maintenance', 'pending_approval', 'rejected'] } },
            { name: 'due', in: 'query', schema: { type: 'string', enum: ['overdue', 'today', 'tomorrow', 'still_good'] } },
            { name: 'cycle', in: 'query', schema: { type: 'string', enum: ['1_week', '2_weeks', '1_month', '1_year'] } },
            { name: 'scope', in: 'query', schema: { type: 'string', enum: ['mine', 'department'] } },
            { name: 'approvalOnly', in: 'query', schema: { type: 'string', enum: ['1'] } },
          ],
          responses: {
            200: { description: '{ ids, total }' },
            404: { description: 'userId khong ton tai' },
          },
        },
      },
      '/api/devices/by-qr': {
        get: {
          tags: ['devices'],
          summary: 'Tim thiet bi theo ma QR',
          description:
            'Can token. Tim chinh xac theo ma thiet bi (equ_no); khong co ma nao khac duoc chap nhan. ' +
            'Truyen userId: thiet bi thuoc bo phan khac voi nguoi goi se tra 403 (dung cho trang quet ma bao duong va chuyen phan xuong). ' +
            'Bo userId neu thuc su can tim khong kem kiem tra bo phan.',
          parameters: [
            { name: 'qr', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 100 } },
            { name: 'userId', in: 'query', schema: { type: 'string' }, description: 'Tuy chon. Truyen de kiem tra cung bo phan' },
          ],
          responses: {
            200: { description: 'Thiet bi (DeviceRecord)' },
            403: { description: 'Thiet bi thuoc bo phan khac' },
            404: { description: 'Khong tim thay thiet bi' },
          },
        },
      },
      '/api/devices/managed': {
        get: {
          tags: ['devices'],
          summary: 'Thiet bi minh quan ly (chi approver cu)',
          description: 'Can token. Danh sach thiet bi co approver_id la minh. Vi tri khac approver se tra 403.',
          parameters: [
            { name: 'userId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: { description: '{ items }' },
            403: { description: 'Vi tri khong duoc phep' },
            404: { description: 'userId khong ton tai' },
          },
        },
      },
      '/api/devices/factories': {
        get: {
          tags: ['devices'],
          summary: 'Danh sach phan xuong de chuyen',
          description: 'Can token. Danh sach phan xuong (xuong_mnt) dung trong man hinh chuyen phan xuong.',
          responses: { 200: { description: '{ factories }' } },
        },
      },
      '/api/devices/maintainer-candidates': {
        get: {
          tags: ['devices'],
          summary: 'Ung vien de giao nguoi phu trach',
          description: 'Can token. Admin thay toan bo; vi tri khac chi thay nhan vien bao tri trong bo phan minh.',
          parameters: [
            { name: 'userId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'deviceId', in: 'query', schema: { type: 'string' }, description: 'Tuy chon' },
          ],
          responses: {
            200: { description: '{ candidates }' },
            404: { description: 'userId khong ton tai' },
          },
        },
      },
      '/api/devices/bulk-approve-completion': {
        post: {
          tags: ['devices'],
          summary: 'Duyet hang loat',
          description:
            'Can token. Chi duyet duoc thiet bi pending_approval thuoc pham vi cua minh: bo phan minh (chu quan/van thu) hoac phan xuong minh la thanh vien nhom duyet. ' +
            'Duyet thanh cong: trang thai = not_due, max_mt_date = ngay hien tai, tao don eqm_mt1/eqm_mt2, dong episode tre han, gui push cho nhom duyet con lai + nguoi gui + chu quan/van thu bo phan.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ids', 'userId'],
                  properties: {
                    ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    userId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success, processed }' },
            400: { description: 'ids rong' },
            403: { description: 'Khong trung nguoi dang nhap' },
            404: { description: 'userId khong ton tai' },
          },
        },
      },
      '/api/devices/bulk-reject-completion': {
        post: {
          tags: ['devices'],
          summary: 'Tu choi hang loat',
          description:
            'Can token. Pham vi nhu duyet hang loat (bo phan minh hoac phan xuong minh). Tu choi: trang thai = rejected, giu ly do; episode tre han van duoc tinh (doi cron doi reason thanh rejected).',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ids', 'userId', 'reason'],
                  properties: {
                    ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    userId: { type: 'string' },
                    reason: { type: 'string', minLength: 1, maxLength: 2000 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success, processed }' },
            400: { description: 'ids rong' },
            403: { description: 'Khong trung nguoi dang nhap' },
            404: { description: 'userId khong ton tai' },
          },
        },
      },
      '/api/devices/{id}': {
        get: {
          tags: ['devices'],
          summary: 'Chi tiet thiet bi',
          description: 'Can token.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'userId', in: 'query', schema: { type: 'string' }, description: 'Tuy chon. Truyen de kem nguoi dung trong du lieu tra ve' },
          ],
          responses: {
            200: { description: 'Thiet bi (DeviceRecord)' },
            404: { description: 'Khong tim thay' },
          },
        },
      },
      '/api/devices/{id}/status': {
        patch: {
          tags: ['devices'],
          summary: 'Cap nhat trang thai bao duong',
          description:
            'Can token. Chuyen sang in_maintenance (bat dau bao duong): neu khong phai nguoi phu trach chinh se tu dong ghi tiep quan tam thoi (temp_maintainer_emp_no + temp_maintainer_date = ngay quet) — temp giu den khi xong viec, khong het han qua ngay. ' +
            'Thiet bi dang co nguoi khac bao duong -> 409; khac bo phan -> 403; pending_approval thi khong duoc doi trang thai khac.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['userId', 'status'],
                  properties: {
                    userId: { type: 'string' },
                    status: { type: 'string', enum: ['not_due', 'needs_maintenance', 'in_maintenance', 'pending_approval', 'rejected'] },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success }' },
            400: { description: 'Trang thai khong hop le' },
            403: { description: 'Khac bo phan hoac khong trung nguoi dang nhap' },
            404: { description: 'Khong tim thay thiet bi' },
            409: { description: 'Thiet bi dang co nguoi khac bao duong' },
          },
        },
      },
      '/api/devices/{id}/submit-approval': {
        post: {
          tags: ['devices'],
          summary: 'Gui xet duyet hoan thanh',
          description:
            'Can token. Chi nguoi dang bao duong (temp ?? phu trach chinh) hoac admin moi duoc gui. ' +
            'in_maintenance: bat buoc truyen itemIds (cac hang muc da chon); rejected: gui lai, itemIds tuy chon. ' +
            'Du lieu: trang thai = pending_approval, snapshot hang muc vao pending_maintenance_items, completion_requested_at = GETDATE(); ' +
            'episode tre han duoc treo; push gui den nhom duyet phan xuong + chu quan/van thu bo phan.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['userId'],
                  properties: {
                    userId: { type: 'string' },
                    itemIds: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success }' },
            400: { description: 'Chon hang muc hoac trang thai khong hop le' },
            403: { description: 'Khac bo phan / khong phai nguoi dang bao duong' },
            404: { description: 'Khong tim thay thiet bi' },
            409: { description: 'Nguoi khac dang bao duong thiet bi nay' },
          },
        },
      },
      '/api/devices/{id}/undo-maintenance': {
        post: {
          tags: ['devices'],
          summary: 'Hoan tac bao duong',
          description:
            'Can token. Ap dung cho trang thai in_maintenance hoac rejected. Chi nguoi da quet (temp ?? phu trach chinh) hoac chu quan/van thu cua bo phan thiet bi moi duoc hoan tac (admin cung khong duoc). ' +
            'Trang thai duoc tinh lai theo han bao duong, khong doi ngay bao duong gan nhat; xoa tiep quan tam thoi, ly do tu choi va snapshot hang muc.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['userId'],
                  properties: { userId: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success, newStatus }' },
            400: { description: 'Trang thai khong ho tro hoan tac' },
            403: { description: 'Khong co quyen hoan tac' },
            404: { description: 'Khong tim thay thiet bi' },
          },
        },
      },
      '/api/devices/{id}/transfer-factory': {
        post: {
          tags: ['devices'],
          summary: 'Chuyen phan xuong',
          description:
            'Can token. Doi approver_emp_no sang ma phan xuong moi va cap nhat equ_addr. ' +
            'Neu truyen newMaintainerId: gan lai nguoi phu trach, xoa tiep quan tam thoi va chuyen bo phan theo nguoi phu trach moi. ' +
            'Quyen: admin duoc chuyen tat ca; nhan vien/chu quan/van thu chi duoc chuyen thiet bi trong bo phan minh.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['userId', 'targetFactory'],
                  properties: {
                    userId: { type: 'string' },
                    targetFactory: { type: 'string' },
                    newMaintainerId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success, device }' },
            400: { description: 'Phan xuong khong ton tai hoac nguoi phu trach khong hop le' },
            403: { description: 'Khac bo phan hoac khong trung nguoi dang nhap' },
            404: { description: 'Khong tim thay thiet bi' },
          },
        },
      },
      '/api/devices/{id}/approve-completion': {
        post: {
          tags: ['devices'],
          summary: 'Xac nhan hoan thanh bao duong',
          description:
            'Can token. Quyen duyet (thoa 1 trong 3): thanh vien nhom duyet phan xuong (chu quan / pho quan 1 / pho quan 2 trong xuong_mnt), chu quan hoac van thu bo phan thiet bi, hoac chinh nguoi dang bao duong thiet bi do. ' +
            'Thanh cong: trang thai = not_due, max_mt_date = ngay hien tai, xoa temp va snapshot hang muc, tao don eqm_mt1/eqm_mt2 (check_user = nguoi duyet, check_date = luc duyet), dong episode tre han va gui push thong bao.',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['userId'],
                  properties: { userId: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success }' },
            400: { description: 'Khong o trang thai cho duyet' },
            403: { description: 'Khong co quyen duyet' },
            404: { description: 'Khong tim thay thiet bi' },
          },
        },
      },
      '/api/devices/{id}/reject-completion': {
        post: {
          tags: ['devices'],
          summary: 'Tu choi hoan thanh bao duong',
          description:
            'Can token. Quyen tu choi: thanh vien nhom duyet phan xuong hoac chu quan/van thu bo phan thiet bi (nhan vien bao duong khong duoc tu choi). ' +
            'Tu choi: trang thai = rejected, luu ly do; temp van giu de nguoi dang lam tiep tuc khac phuc; episode tre han duoc tinh (cron doi reason thanh rejected).',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['userId', 'reason'],
                  properties: {
                    userId: { type: 'string' },
                    reason: { type: 'string', minLength: 1, maxLength: 2000 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success }' },
            400: { description: 'Khong o trang thai cho duyet' },
            403: { description: 'Khong co quyen tu choi' },
            404: { description: 'Khong tim thay thiet bi' },
          },
        },
      },

      // ==== Maintenance orders ====
      '/api/maintenance-orders/templates': {
        get: {
          tags: ['maintenance-orders'],
          summary: 'Hang muc bao duong chuan theo loai thiet bi',
          description:
            'Can token. Lay danh sach hang muc (eqm_bas_mt) loc theo equ_type va chu ky (mtFlag: 1=tuan, 2=2 tuan, 3=thang, 4=nam). Dung cho man hinh chon hang muc khi bao duong.',
          parameters: [
            { name: 'equType', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 50 } },
            { name: 'mtFlag', in: 'query', required: true, schema: { type: 'integer', minimum: 1, maximum: 4 } },
          ],
          responses: {
            200: { description: '{ items }' },
            400: { description: 'equType hoac mtFlag khong hop le' },
          },
        },
      },
      '/api/maintenance-orders/device/{deviceId}': {
        get: {
          tags: ['maintenance-orders'],
          summary: 'Don bao duong theo thiet bi',
          description: 'Can token. Lay danh sach don bao duong (eqm_mt1) cua thiet bi theo ma (equ_no), kem chi tiet hang muc (eqm_mt2).',
          parameters: [{ name: 'deviceId', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 50 } }],
          responses: { 200: { description: '{ items }' } },
        },
      },

      // ==== Delayed ====
      '/api/delayed-devices': {
        get: {
          tags: ['delayed'],
          summary: 'Lich su tre han (chi admin)',
          description:
            'Can token, chi admin. Danh sach episode trong eqm_mnt_delay (moi nhat truoc), kem so episode, ten nguoi phu trach, ten bo phan. Ho tro loc theo ly do (reason) va phan trang. Tra ve tong so episode lich su va so lieu theo bo phan.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'userId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'reason', in: 'query', schema: { type: 'string', enum: ['not_started', 'in_progress', 'awaiting_approval', 'rejected'] } },
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          ],
          responses: {
            200: { description: '{ items, total, page, pageSize, reasonCounts, lastSyncedAt, totalEpisodes, deptHistoryCounts }' },
            403: { description: 'Chi admin moi xem duoc / khong trung nguoi dang nhap' },
            404: { description: 'userId khong ton tai' },
          },
        },
      },
      '/api/delayed-devices/sync': {
        post: {
          tags: ['delayed'],
          summary: 'Dong bo lich su tre han ngay (chi admin)',
          description:
            'Can token, chi admin. Chay cung logic voi cron hang ngay (scripts/daily-sync.js): doi chieu episode eqm_mnt_delay, mo episode moi (ke ca cho duyet qua ngay an han), dong episode het tre. Idempotent. ' +
            'Nguon ghi chinh van la cron Linux 00:05 (gio HK); endpoint nay chi de bam tay khi can.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['userId'],
                  properties: { userId: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success, syncedAt, closedCount, updatedCount, insertedCount }' },
            403: { description: 'Chi admin moi duoc dong bo / khong trung nguoi dang nhap' },
            404: { description: 'userId khong ton tai' },
          },
        },
      },

      // ==== Holidays ====
      '/api/holidays': {
        get: {
          tags: ['holidays'],
          summary: 'Danh sach ngay nghi',
          description:
            'Can token. Lay ngay nghi do HR khai bao (bang hr_holiday), tuy chon loc theo nam. Ngay nghi + Chu nhat duoc dung de doi han bao duong va ngay an han duyet sang ngay lam viec ke tiep (Thu 7 van di lam).',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'year', in: 'query', schema: { type: 'integer', minimum: 2000, maximum: 2100 }, description: 'Loc theo nam (tuy chon)' },
          ],
          responses: {
            200: { description: '{ items: [{ date, name, createdBy, createdAt }] }' },
            401: { description: 'Chua dang nhap' },
          },
        },
        post: {
          tags: ['holidays'],
          summary: 'Them ngay nghi (chi HR/admin)',
          description: 'Can token, chi vi tri hr hoac admin. Them toi da 120 ngay mot lan; ngay trung se duoc bo qua (skipped).',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    items: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 120,
                      items: {
                        type: 'object',
                        required: ['date'],
                        properties: {
                          date: { type: 'string', description: 'Dinh dang YYYY-MM-DD' },
                          name: { type: 'string', description: 'Ten ngay nghi (tuy chon)' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success, inserted, skipped }' },
            403: { description: 'Chi HR hoac admin moi duoc them' },
          },
        },
      },
      '/api/holidays/{date}': {
        delete: {
          tags: ['holidays'],
          summary: 'Xoa ngay nghi (chi HR/admin)',
          description: 'Can token, chi vi tri hr hoac admin. Xoa mot ngay khoi bang hr_holiday.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'date', in: 'path', required: true, schema: { type: 'string' }, description: 'Dinh dang YYYY-MM-DD' },
          ],
          responses: {
            200: { description: '{ deleted }' },
            403: { description: 'Chi HR hoac admin moi duoc xoa' },
            404: { description: 'Ngay khong ton tai' },
          },
        },
      },

      // ==== Xuong ====
      '/api/xuongs/mine': {
        get: {
          tags: ['xuongs'],
          summary: 'Phan xuong cua nguoi dang nhap',
          description:
            'Can token. Tra ve cac phan xuong ma nguoi dang nhap la thanh vien nhom duyet (chu quan / pho quan 1 / pho quan 2 trong xuong_mnt). ' +
            'Giao dien dung de quyet dinh hien menu "Thiet bi can duyet" va trang /dept-approval.',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: '{ workshops }' },
            401: { description: 'Chua dang nhap' },
          },
        },
      },

      // ==== Push ====
      '/api/push/register': {
        post: {
          tags: ['push'],
          summary: 'Dang ky token push (FCM)',
          description:
            'Can token. empNo lay tu phien dang nhap. Mot nguoi nhieu thiet bi la hop le (moi thiet bi mot token); dang ky trung chi cap nhat. ' +
            'Giao dien chan dang ky trong webview Feishu/Lark; iPhone can "Them vao man hinh chinh" moi nhan duoc.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token'],
                  properties: {
                    token: { type: 'string', minLength: 10, maxLength: 500 },
                    deviceLabel: { type: 'string', maxLength: 200, description: 'Mo ta thiet bi (tuy chon)' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success }' },
            401: { description: 'Chua dang nhap' },
          },
        },
      },
      '/api/push/unregister': {
        post: {
          tags: ['push'],
          summary: 'Huy dang ky token push',
          description: 'Can token. Go token cua chinh minh (goi khi dang xuat).',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['token'],
                  properties: { token: { type: 'string', minLength: 10, maxLength: 500 } },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success }' },
            401: { description: 'Chua dang nhap' },
          },
        },
      },
      '/api/push/log': {
        get: {
          tags: ['push'],
          summary: 'Lich su gui push (chi admin)',
          description: 'Can token, chi admin. Bang push_log, moi nhat truoc, co phan trang.',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
          ],
          responses: {
            200: { description: '{ items, total, page, pageSize }' },
            403: { description: 'Chi admin' },
          },
        },
      },
      '/api/push/tokens': {
        get: {
          tags: ['push'],
          summary: 'Danh sach thiet bi da dang ky push (chi admin)',
          description: 'Can token, chi admin. Danh sach token push kem nguoi dung, thiet bi va trang thai hoat dong.',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: '{ items }' },
            403: { description: 'Chi admin' },
          },
        },
      },
      '/api/push/toggle-token': {
        post: {
          tags: ['push'],
          summary: 'Bat/tat token push (chi admin)',
          description: 'Can token, chi admin. Bat hoac tat mot token da dang ky (token chet do FCM tu dong bi tat khi gui that bai).',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'isActive'],
                  properties: {
                    id: { type: 'integer', minimum: 1 },
                    isActive: { type: 'boolean' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '{ success }' },
            403: { description: 'Chi admin' },
            404: { description: 'Token khong ton tai' },
          },
        },
      },
      '/api/push/test': {
        post: {
          tags: ['push'],
          summary: 'Gui push thu (chi admin)',
          description:
            'Can token, chi admin. Khong truyen targetEmpNo = gui thu toi toan bo token dang hoat dong. ' +
            'Khong duoc dat ten truong la empNo (middleware chot danh tinh se chan); dung targetEmpNo.',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { targetEmpNo: { type: 'string', maxLength: 20, description: 'MNV nguoi nhan (tuy chon)' } },
                },
              },
            },
          },
          responses: {
            200: { description: 'Ket qua gui thu' },
            403: { description: 'Chi admin' },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Token tra ve sau khi dang nhap (pin/verify hoac face/verify). Hieu luc 30 ngay. Gui: Authorization: Bearer <token>',
        },
      },
    },
  };
}

module.exports = { buildSpec };
