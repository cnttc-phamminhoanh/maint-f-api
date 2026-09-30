const express = require('express');
const Joi = require('joi');
const { asyncHandler } = require('../errors');
const { validate, getQuery } = require('../middleware/validate');
const orderService = require('../services/maintenance-order.service');

const router = express.Router();

router.get(
  '/templates',
  validate(
    Joi.object({
      equType: Joi.string().allow('').default(''),
      mtFlag: Joi.string().valid('1', '2', '3', '4').optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = getQuery(req);
    const items = await orderService.listTemplates(q.equType, q.mtFlag);
    res.json({ items });
  }),
);

router.get(
  '/device/:deviceId',
  validate(Joi.object({ deviceId: Joi.string().min(1).max(50).required() }), 'params'),
  asyncHandler(async (req, res) => {
    const items = await orderService.listOrdersByDevice(req.params.deviceId);
    res.json({ items, total: items.length });
  }),
);

module.exports = router;
