const express = require('express');
const Joi = require('joi');
const { asyncHandler } = require('../errors');
const { validate, getQuery } = require('../middleware/validate');
const delayedService = require('../services/delayed.service');

const router = express.Router();

router.get(
  '/',
  validate(
    Joi.object({
      userId: Joi.string().min(1).max(40).required(),
      reason: Joi.string().valid(...delayedService.REASONS).optional(),
      page: Joi.number().integer().min(1).default(1),
      pageSize: Joi.number().integer().min(1).max(100).default(30),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    res.json(await delayedService.adminList(q.userId, q.reason || '', q.page, q.pageSize));
  }),
);

router.post(
  '/sync',
  validate(Joi.object({ userId: Joi.string().min(1).max(40).required() })),
  asyncHandler(async (req, res) => {
    res.json(await delayedService.adminSync(req.body.userId));
  }),
);

module.exports = router;
