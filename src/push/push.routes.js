const express = require('express');
const Joi = require('joi');
const { ApiError, asyncHandler } = require('../errors');
const { validate, getQuery } = require('../middleware/validate');
const pushService = require('./push.service');

const router = express.Router();

// Chi admin moi dung duoc cac endpoint quan tri push
function requireAdmin(req, res, next) {
  if (req.user.position !== 'admin') return next(new ApiError(403, 'not allowed'));
  return next();
}

// empNo lay tu phien (requireAuth da chay truoc do)
router.post(
  '/register',
  validate(Joi.object({
    token: Joi.string().min(10).max(500).required(),
    deviceLabel: Joi.string().max(200).allow('').optional(),
  })),
  asyncHandler(async (req, res) => {
    await pushService.registerToken(req.user.empNo, req.body.token, req.body.deviceLabel || '');
    res.json({ success: true });
  }),
);

router.post(
  '/unregister',
  validate(Joi.object({ token: Joi.string().min(10).max(500).required() })),
  asyncHandler(async (req, res) => {
    await pushService.unregisterToken(req.user.empNo, req.body.token);
    res.json({ success: true });
  }),
);

router.get(
  '/log',
  requireAdmin,
  validate(
    Joi.object({
      page: Joi.number().integer().min(1).default(1),
      pageSize: Joi.number().integer().min(1).max(100).default(30),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await pushService.listLog(q.page, q.pageSize));
  }),
);

router.get(
  '/tokens',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await pushService.listTokens());
  }),
);

router.post(
  '/toggle-token',
  requireAdmin,
  validate(Joi.object({
    id: Joi.number().integer().min(1).required(),
    isActive: Joi.boolean().required(),
  })),
  asyncHandler(async (req, res) => {
    res.json(await pushService.toggleToken(req.body.id, req.body.isActive));
  }),
);

// Field nguoi nhan dat ten targetEmpNo (khong duoc dat empNo):
// requireAuth chan moi body/query co empNo khac chu phien (403 TOKEN_USER_MISMATCH),
// admin se khong gui test cho nguoi khac duoc
router.post(
  '/test',
  requireAdmin,
  validate(Joi.object({
    targetEmpNo: Joi.string().max(20).optional(),
  })),
  asyncHandler(async (req, res) => {
    const target = req.body.targetEmpNo || req.user.empNo;
    res.json(await pushService.sendTest(target));
  }),
);

module.exports = router;
