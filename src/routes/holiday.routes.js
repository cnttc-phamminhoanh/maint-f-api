const express = require('express');
const Joi = require('joi');
const holidayService = require('../services/holiday.service');
const { ApiError } = require('../errors');

const router = express.Router();

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
router.get('/', async (req, res, next) => {
  try {
    const { value } = listSchema.validate(req.query);
    const items = await holidayService.listHolidays(value.year);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// POST /api/holidays  { items: [{date, name}] }
router.post('/', requireHolidayManager, async (req, res, next) => {
  try {
    const { value, error } = createSchema.validate(req.body || {});
    if (error) throw new ApiError(400, error.message);
    const result = await holidayService.createHolidays(value.items, req.user.empNo);
    res.json({ success: true, inserted: result.inserted, skipped: result.skipped });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/holidays/:date  (date = YYYY-MM-DD)
router.delete('/:date', requireHolidayManager, async (req, res, next) => {
  try {
    const result = await holidayService.deleteHoliday(req.params.date);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
