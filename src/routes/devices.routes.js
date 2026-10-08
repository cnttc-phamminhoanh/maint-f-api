const express = require('express');
const Joi = require('joi');
const { asyncHandler } = require('../errors');
const { validate, getQuery } = require('../middleware/validate');
const devicesService = require('../services/devices.service');

const router = express.Router();

const STATUSES = ['needs_maintenance', 'in_maintenance', 'pending_approval', 'rejected', 'not_due'];
const DUE_VALUES = ['all', 'overdue', 'today', 'tomorrow', 'later'];
const CYCLES = ['1_week', '2_weeks', '1_month', '1_year'];

const pageSchema = Joi.number().integer().min(1).default(1);
const pageSizeSchema = (max) => Joi.number().integer().min(1).max(max).default(30);
const deviceIdParam = (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) {
    return next(new (require('../errors').ApiError)(404, 'Không tìm thấy thiết bị'));
  }
  return next();
};

router.get(
  '/',
  validate(
    Joi.object({
      userId: Joi.string().allow('').default(''),
      search: Joi.string().allow('').default(''),
      status: Joi.string().valid(...STATUSES).optional(),
      due: Joi.string().valid(...DUE_VALUES).optional(),
      cycle: Joi.string().valid(...CYCLES).optional(),
      page: pageSchema,
      pageSize: pageSizeSchema(100),
      scope: Joi.string().valid('mine', 'department').optional(),
      approvalOnly: Joi.string().valid('1').optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await devicesService.listDevices(q));
  }),
);

router.get(
  '/by-qr',
  validate(
    Joi.object({
      qr: Joi.string().min(1).max(100).required(),
      userId: Joi.string().allow('').optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await devicesService.lookupDeviceByQr(q.qr, q.userId || undefined));
  }),
);

router.get(
  '/managed',
  validate(
    Joi.object({
      userId: Joi.string().min(1).max(40).required(),
      sortBy: Joi.string().valid('name', 'due').default('due'),
      page: pageSchema,
      pageSize: pageSizeSchema(100),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await devicesService.listManagedDevices(q.userId, q.sortBy, q.page, q.pageSize));
  }),
);

router.get(
  '/factories',
  validate(Joi.object({ userId: Joi.string().allow('').default('') }), 'query'),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await devicesService.listFactories(q.userId));
  }),
);

router.get(
  '/maintainer-candidates',
  validate(Joi.object({ userId: Joi.string().allow('').default('') }), 'query'),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await devicesService.listMaintainerCandidates(q.userId));
  }),
);

router.post(
  '/bulk-approve-completion',
  validate(
    Joi.object({
      ids: Joi.array().items(Joi.string().min(1)).min(1).required(),
      userId: Joi.string().min(1).max(40).required(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(await devicesService.bulkApproveCompletion(req.body.ids, req.body.userId));
  }),
);

router.post(
  '/bulk-reject-completion',
  validate(
    Joi.object({
      ids: Joi.array().items(Joi.string().min(1)).min(1).required(),
      userId: Joi.string().min(1).max(40).required(),
      reason: Joi.string().allow('').max(500).default(''),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(await devicesService.bulkRejectCompletion(req.body.ids, req.body.userId, req.body.reason));
  }),
);

router.get(
  '/:id',
  deviceIdParam,
  asyncHandler(async (req, res) => {
    res.json(await devicesService.getDeviceById(req.params.id));
  }),
);

router.patch(
  '/:id/status',
  deviceIdParam,
  validate(
    Joi.object({
      status: Joi.string().valid(...STATUSES).required(),
      userId: Joi.string().min(1).max(40).required(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(await devicesService.updateDeviceStatus(req.params.id, req.body.status, req.body.userId));
  }),
);

router.post(
  '/:id/submit-approval',
  deviceIdParam,
  validate(
    Joi.object({
      userId: Joi.string().min(1).max(40).required(),
      itemIds: Joi.array().items(Joi.string().min(1)).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(await devicesService.submitApproval(req.params.id, req.body.userId, req.body.itemIds));
  }),
);

router.post(
  '/:id/undo-maintenance',
  deviceIdParam,
  validate(Joi.object({ userId: Joi.string().min(1).max(40).required() })),
  asyncHandler(async (req, res) => {
    res.json(await devicesService.undoMaintenance(req.params.id, req.body.userId));
  }),
);

router.post(
  '/:id/transfer-factory',
  deviceIdParam,
  validate(
    Joi.object({
      userId: Joi.string().min(1).max(40).required(),
      targetFactory: Joi.string().min(1).max(50).required(),
      newMaintainerId: Joi.string().allow(null, '').optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(
      await devicesService.transferFactory(req.params.id, {
        targetFactory: req.body.targetFactory,
        newMaintainerId: req.body.newMaintainerId || null,
      }, req.body.userId),
    );
  }),
);

router.post(
  '/:id/approve-completion',
  deviceIdParam,
  validate(Joi.object({ userId: Joi.string().min(1).max(40).required() })),
  asyncHandler(async (req, res) => {
    res.json(await devicesService.approveCompletion(req.params.id, req.body.userId));
  }),
);

router.post(
  '/:id/reject-completion',
  deviceIdParam,
  validate(
    Joi.object({
      userId: Joi.string().min(1).max(40).required(),
      reason: Joi.string().allow('').max(500).default(''),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json(await devicesService.rejectCompletion(req.params.id, req.body.userId, req.body.reason));
  }),
);

module.exports = router;
