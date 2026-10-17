const { Router } = require('express');
const { requireAuth } = require('../middleware/require-auth');
const workshopService = require('../services/workshop.service');

const router = Router();

// 2026-10-17: nhom l_code cua thanh vien dang nhap trong eqm_bas_user
// (chi chua approver / chu quan / van thu). FE dung de quyet dinh hien menu
// "Thiet bi can duyet" va guard trang /dept-approval. Thanh vien nhieu nhom thi tra ve tat ca.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const workshops = await workshopService.getMyWorkshops(req.user.empNo);
    res.json({ workshops });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
