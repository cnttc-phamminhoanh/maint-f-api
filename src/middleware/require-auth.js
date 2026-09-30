const { getSession } = require('../utils/session');
const { ApiError } = require('../errors');

// Bat buoc header: Authorization: Bearer <token>
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const session = await getSession(token);
    if (!session) throw new ApiError(401, 'UNAUTHORIZED');
    req.user = {
      // Ep kieu chuoi: driver mssql co the tra id dang so neu cot la int/bigint,
      // trong khi moi schema Joi cua userId deu la Joi.string()
      id: String(session.id),
      empNo: session.emp_no,
      position: session.position || '',
      departmentId: session.mnt_dept_no || null,
      token,
    };
    // userId trong request do server áp đặt từ phiên — client truyền gì cũng bị ghi đè,
    // không thể mượn danh tính người khác
    if (req.body && typeof req.body === 'object') req.body.userId = String(session.id);
    if (req.query) req.query.userId = String(session.id);
    // empNo (MNV) phải là của chủ phiên — khai báo MNV người khác → chặn ngay
    // (bịt lỗ hổng /user/profile, /pin/change, /face/register đọc empNo thay vì userId)
    const declaredEmpNo =
      req.body && typeof req.body === 'object' && req.body.empNo !== undefined && req.body.empNo !== null
        ? req.body.empNo
        : req.query && req.query.empNo !== undefined && req.query.empNo !== null
          ? req.query.empNo
          : undefined;
    if (declaredEmpNo !== undefined && String(declaredEmpNo) !== String(session.emp_no)) {
      throw new ApiError(403, 'TOKEN_USER_MISMATCH');
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Lop kiem tra thu hai: userId duoc truyen phai la id hoac MNV cua chu phien
// (requireAuth da ghi de userId, lop nay chan truong hop body khong phai object)
function assertSameUser(req, res, next) {
  const declared = (req.body && req.body.userId) || (req.query && req.query.userId);
  if (
    declared !== undefined &&
    declared !== null &&
    String(declared) !== String(req.user.id) &&
    String(declared) !== String(req.user.empNo)
  ) {
    return next(new ApiError(403, 'TOKEN_USER_MISMATCH'));
  }
  next();
}

module.exports = { requireAuth, assertSameUser };
