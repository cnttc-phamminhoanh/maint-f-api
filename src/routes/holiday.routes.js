const { Router } = require('express');
const Joi = require('joi');
const holidayService = require('../services/holiday.service');
const { ApiError, asyncHandler } = require('../errors');
const { validate, getQuery } = require('../middleware/validate');

const router = Router();

// Chỉ HR và admin mới được thêm/xóa ngày nghỉ; các vị trí khác chỉ đọc.
function requireHolidayManager(req, res, next) {
  const pos = req.user && req.user.position;
  if (pos !== 'hr' && pos !== 'admin') {
    return next(new ApiError(403, 'FORBIDDEN'));
  }
  return next();
}

const listSchema = Joi.object({
  year: Joi.number().integer().min(2000).max(2100).optional(),
});

const createSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        date: Joi.string().required(),
        name: Joi.string().allow('').optional(),
      }),
    )
    .min(1)
    .max(120)
    .required(),
});

// GET /api/holidays?year=2026
router.get(
  '/',
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    const items = await holidayService.listHolidays(getQuery(req).year);
    res.json({ items });
  }),
);

// POST /api/holidays  { items: [{date, name}] }
// validate middleware stripUnknown: bo cac key thua (vd userId) thay vi 400
router.post(
  '/',
  requireHolidayManager,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const result = await holidayService.createHolidays(req.body.items, req.user.empNo);
    res.json({ success: true, inserted: result.inserted, skipped: result.skipped });
  }),
);

// DELETE /api/holidays/:date  (date = YYYY-MM-DD)
router.delete(
  '/:date',
  requireHolidayManager,
  asyncHandler(async (req, res) => {
    const result = await holidayService.deleteHoliday(req.params.date);
    res.json(result);
  }),
);

module.exports = router;
