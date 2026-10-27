// Episode do (nhan vien) cua thiet bi dang cho duyet = "treo": van mo trong DB
// nhung an khoi moi view cho den khi duyet (dong) hoac tu choi (tiep tuc). 2026-10-09.
// Episode awaiting_approval (trach nhiem nguoi duyet) thi VAN HIEN THI binh thuong
// o tat ca view quan tri (BI/admin/lich su) khi qua an han.
const SUSPENDED_EPISODE_SQL = `NOT (
  d.resolved_at IS NULL
  AND d.reason <> 'awaiting_approval'
  AND EXISTS (
    SELECT 1 FROM eqm_mnt m
    WHERE m.equ_no = d.equ_no
      AND m.maintenance_status = 'pending_approval'))`;

module.exports = { SUSPENDED_EPISODE_SQL };
