const express = require('express');
const Joi = require('joi');
const { asyncHandler } = require('../errors');
const { validate, getQuery } = require('../middleware/validate');
const statsService = require('../services/statistics.service');

const router = express.Router();

const CYCLES = ['1_week', '2_weeks', '1_month', '1_year'];

router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    res.json(await statsService.getOverview());
  }),
);

router.get(
  '/delayed-devices',
  validate(
    Joi.object({
      reason: Joi.string().valid('not_started', 'in_progress', 'awaiting_approval', 'rejected').optional(),
      page: Joi.number().integer().min(1).default(1),
      pageSize: Joi.number().integer().min(1).max(100).default(30),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await statsService.getDelayedStatistics(q.reason || '', q.page, q.pageSize));
  }),
);

router.get(
  '/equipment',
  validate(
    Joi.object({
      factory: Joi.string().allow('').default(''),
      empNo: Joi.string().allow('').default(''),
      respEmpNo: Joi.string().allow('').default(''),
      maintType: Joi.string().valid(...CYCLES).optional().allow(''),
      equNo: Joi.string().allow('').default(''),
      maintenanceStatus: Joi.string().allow('').default(''),
      delayReason: Joi.string().allow('').default(''),
      due: Joi.string().allow('').default(''),
      page: Joi.number().integer().min(1).default(1),
      pageSize: Joi.number().integer().min(1).max(100).default(50),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await statsService.getEquipmentStatistics(q));
  }),
);

router.get(
  '/delay-history',
  validate(
    Joi.object({
      dept: Joi.string().allow('').default(''),
      page: Joi.number().integer().min(1).default(1),
      pageSize: Joi.number().integer().min(1).max(50).default(20),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await statsService.getDelayHistory(q.dept || '', q.page, q.pageSize));
  }),
);

module.exports = router;
