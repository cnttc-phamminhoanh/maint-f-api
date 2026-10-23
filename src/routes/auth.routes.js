const express = require('express');
const Joi = require('joi');
const { asyncHandler } = require('../errors');
const { validate, getQuery } = require('../middleware/validate');
const { requireAuth } = require('../middleware/require-auth');
const { destroySession } = require('../utils/session');
const authService = require('../services/auth.service');

const router = express.Router();

// MNV (emp_no) — thứ duy nhất nhân viên nhớ; không bắt họ biết id tự tăng
const empNoField = Joi.string().min(1).max(100).required();

router.get(
  '/user/lookup',
  validate(Joi.object({ empNo: Joi.string().min(1).max(100).required() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await authService.lookupUser(q.empNo));
  }),
);

router.get(
  '/user/status',
  validate(Joi.object({ empNo: empNoField }), 'query'),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await authService.getUserStatus(q.empNo));
  }),
);

router.post(
  '/user/register',
  validate(
    Joi.object({
      empNo: Joi.string().min(2).max(100).required(),
      empName: Joi.string().max(200).optional().allow(''),
      // Mat khau mo dang ky bat buoc phai gui len — server kiem tra, khong chi la gate UI
      accessPassword: Joi.string().min(1).max(200).required(),
      // 2026-10-20: position bat buoc; mntDeptNo/location tuy position, server validate
      position: Joi.string().min(1).max(50).required(),
      mntDeptNo: Joi.string().max(50).optional().allow('', null),
      location: Joi.string().max(50).optional().allow('', null),
      // 2026-10-23: approver chon nhieu phan xuong
      locations: Joi.array().items(Joi.string().min(1).max(50)).max(50).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(await authService.registerUser(req.body.empNo, req.body.empName || '', req.body.accessPassword, {
      position: req.body.position,
      mntDeptNo: req.body.mntDeptNo || null,
      location: req.body.location || null,
      locations: req.body.locations || null,
    }));
  }),
);

// Dropdown cua form đăng ký: position hop le + phong ban + vi tri (code_type 176)
router.get(
  '/register-options',
  asyncHandler(async (req, res) => {
    res.json(await authService.getRegisterOptions());
  }),
);

router.patch(
  '/user/profile',
  requireAuth,
  validate(
    Joi.object({
      empNo: empNoField,
      empName: Joi.string().min(1).max(200).required(),
      avatarUrl: Joi.string().max(2048).optional().allow(''),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(await authService.updateUserProfile(req.body.empNo, req.body.empName, req.body.avatarUrl || ''));
  }),
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await destroySession(req.user.token);
    res.json({ success: true });
  }),
);

router.post(
  '/pin/setup',
  validate(Joi.object({ empNo: empNoField, pin: Joi.string().min(4).max(20).required() })),
  asyncHandler(async (req, res) => {
    res.json(await authService.setupPin(req.body.empNo, req.body.pin));
  }),
);

router.post(
  '/pin/verify',
  validate(Joi.object({ empNo: empNoField, pin: Joi.string().min(1).max(20).required() })),
  asyncHandler(async (req, res) => {
    res.json(await authService.verifyPinLogin(req.body.empNo, req.body.pin));
  }),
);

router.post(
  '/pin/change',
  requireAuth,
  validate(
    Joi.object({
      empNo: empNoField,
      currentPin: Joi.string().min(1).max(20).required(),
      newPin: Joi.string().min(4).max(20).required(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(await authService.changePin(req.body.empNo, req.body.currentPin, req.body.newPin));
  }),
);

router.post(
  '/face/register',
  requireAuth,
  validate(
    Joi.object({
      empNo: empNoField,
      imageUrl: Joi.string().min(1).max(2048).required(),
      relaxClose: Joi.boolean().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(await authService.registerFace(req.body.empNo, req.body.imageUrl, req.body.relaxClose === true));
  }),
);

router.get(
  '/register-access',
  validate(Joi.object({ password: Joi.string().min(1).max(200).required() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await authService.checkRegisterAccess(q.password));
  }),
);

router.post(
  '/face/verify',
  validate(Joi.object({ empNo: empNoField, imageUrl: Joi.string().min(1).max(2048).required() })),
  asyncHandler(async (req, res) => {
    res.json(await authService.verifyFace(req.body.empNo, req.body.imageUrl));
  }),
);

module.exports = router;
