-- ============================================================
-- 002_delay_episode.sql
-- eqm_mnt_delay: chuyen tu "anh hien tai" sang mo hinh episode
-- (moi lan thiet bi tre han = 1 dong; resolved_at danh dau het tre)
-- Chay tren SQL Server cua ban truoc khi deploy ban local-api moi.
-- ============================================================

-- 1) Them cot episode (neu chua co)
IF COL_LENGTH('eqm_mnt_delay', 'occurred_at') IS NULL
  ALTER TABLE eqm_mnt_delay ADD occurred_at DATETIME2 NULL;
GO
IF COL_LENGTH('eqm_mnt_delay', 'resolved_at') IS NULL
  ALTER TABLE eqm_mnt_delay ADD resolved_at DATETIME2 NULL;
GO

-- 2) Backfill thoi diem bat dau tre cho du lieu cu (lay snapshot_at)
UPDATE eqm_mnt_delay SET occurred_at = snapshot_at WHERE occurred_at IS NULL;
GO

-- 3) Mo hinh episode cho phep nhieu dong tren 1 thiet bi (theo thoi gian),
--    vi vay phai bo cac unique index cu (neu co) tren bang nay, tru PK.
DECLARE @idx sysname;
DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
  SELECT i.name
  FROM sys.indexes i
  JOIN sys.objects o ON o.object_id = i.object_id
  WHERE o.name = 'eqm_mnt_delay'
    AND i.is_unique = 1
    AND i.is_primary_key = 0;
OPEN cur;
FETCH NEXT FROM cur INTO @idx;
WHILE @@FETCH_STATUS = 0
BEGIN
  EXEC ('DROP INDEX [' + @idx + '] ON eqm_mnt_delay');
  FETCH NEXT FROM cur INTO @idx;
END
CLOSE cur;
DEALLOCATE cur;
GO

-- 4) Index thuong cho truy van episode
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_eqm_mnt_delay_equ_no' AND object_id = OBJECT_ID('eqm_mnt_delay'))
  CREATE INDEX idx_eqm_mnt_delay_equ_no ON eqm_mnt_delay (equ_no);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_eqm_mnt_delay_resolved_at' AND object_id = OBJECT_ID('eqm_mnt_delay'))
  CREATE INDEX idx_eqm_mnt_delay_resolved_at ON eqm_mnt_delay (resolved_at);
GO
