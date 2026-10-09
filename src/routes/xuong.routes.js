const { Router } = require('express');
const { requireAuth } = require('../middleware/require-auth');
const workshopService = require('../services/workshop.service');

const router = Router();

// 2026-10-09: phan xuong cua thanh vien dang nhap (chu quan xuong / pho chu quan 1
// hoac 2 trong xuong_mnt). FE dung de quyet dinh hien menu "Thiet bi can duyet"
// va guard trang /dept-approval. Thanh vien nhieu xuong thi tra ve tat ca.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const workshops = await workshopService.getMyWorkshops(req.user.empNo);
    res.json({ workshops });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
