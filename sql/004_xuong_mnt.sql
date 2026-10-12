-- ============================================================
-- 004_xuong_mnt.sql
-- Bang phan xuong (xuong_mnt): moi phan xuong co toi da 3 nguoi duyet
-- (chu quan xuong + pho chu quan 1 + pho chu quan 2).
-- eqm_mnt.approver_emp_no tu nay chua MA PHAN XUONG (xuong_no);
-- gui xet duyet se gui cho tat ca thanh vien cua phan xuong do.
-- Chay tren SQL Server truoc khi deploy ban local-api moi.
-- ============================================================

-- 1) Tao bang phan xuong (kieu cot lay theo dung kieu cot hien co
--    cua emp_mnt.emp_no / eqm_mnt.approver_emp_no de FK khong bao loi)
IF OBJECT_ID('dbo.xuong_mnt', 'U') IS NULL
BEGIN
    DECLARE @empNoType NVARCHAR(128);
    SELECT @empNoType = TYPE_NAME(c.user_type_id) +
        CASE WHEN TYPE_NAME(c.user_type_id) LIKE '%char' AND c.max_length > 0
             THEN '(' + CAST(c.max_length /
                  CASE WHEN TYPE_NAME(c.user_type_id) LIKE 'n%' THEN 2 ELSE 1 END
                  AS VARCHAR(10)) + ')'
             ELSE '' END
    FROM sys.columns c
    WHERE c.object_id = OBJECT_ID('dbo.emp_mnt') AND c.name = 'emp_no';

    DECLARE @approverType NVARCHAR(128);
    SELECT @approverType = TYPE_NAME(c.user_type_id) +
        CASE WHEN TYPE_NAME(c.user_type_id) LIKE '%char' AND c.max_length > 0
             THEN '(' + CAST(c.max_length /
                  CASE WHEN TYPE_NAME(c.user_type_id) LIKE 'n%' THEN 2 ELSE 1 END
                  AS VARCHAR(10)) + ')'
             ELSE '' END
    FROM sys.columns c
    WHERE c.object_id = OBJECT_ID('dbo.eqm_mnt') AND c.name = 'approver_emp_no';

    IF @empNoType IS NULL SET @empNoType = 'VARCHAR(100)';
    IF @approverType IS NULL SET @approverType = 'VARCHAR(50)';

    DECLARE @sql NVARCHAR(MAX) = N'
    CREATE TABLE dbo.xuong_mnt (
        id                INT IDENTITY(1,1) NOT NULL,
        xuong_no          ' + @approverType + N' NOT NULL,  -- ma phan xuong (tu dat)
        xuong_name        NVARCHAR(200) NULL,               -- ten phan xuong
        chu_quan_emp_no   ' + @empNoType + N' NULL,         -- chu quan xuong (MNV)
        pho_quan_1_emp_no ' + @empNoType + N' NULL,         -- pho chu quan 1 (MNV)
        pho_quan_2_emp_no ' + @empNoType + N' NULL,         -- pho chu quan 2 (MNV)
        CONSTRAINT pk_xuong_mnt PRIMARY KEY (id),
        CONSTRAINT uq_xuong_mnt_xuong_no UNIQUE (xuong_no),
        CONSTRAINT fk_xuong_mnt_chu_quan FOREIGN KEY (chu_quan_emp_no)
            REFERENCES dbo.emp_mnt (emp_no) ON UPDATE CASCADE,
        CONSTRAINT fk_xuong_mnt_pho_quan_1 FOREIGN KEY (pho_quan_1_emp_no)
            REFERENCES dbo.emp_mnt (emp_no) ON UPDATE CASCADE,
        CONSTRAINT fk_xuong_mnt_pho_quan_2 FOREIGN KEY (pho_quan_2_emp_no)
            REFERENCES dbo.emp_mnt (emp_no) ON UPDATE CASCADE
    )';
    EXEC (@sql);
END
GO

-- 2) Bo FK cu: eqm_mnt.approver_emp_no -> emp_mnt.emp_no
--    (approver_emp_no tu nay chua ma phan xuong, khong con la MNV)
DECLARE @fk SYSNAME;
SELECT @fk = fk.name
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id
                   AND pc.column_id = fkc.parent_column_id
WHERE fk.parent_object_id = OBJECT_ID('dbo.eqm_mnt')
  AND pc.name = 'approver_emp_no';
IF @fk IS NOT NULL
    EXEC ('ALTER TABLE dbo.eqm_mnt DROP CONSTRAINT [' + @fk + ']');
GO

-- 3) FK moi: eqm_mnt.approver_emp_no -> xuong_mnt.xuong_no
--    WITH NOCHECK: cac dong du lieu cu chua validate; moi INSERT/UPDATE
--    se duoc kiem tra -> can INSERT phan xuong TRUOC khi UPDATE thiet bi.
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_eqm_mnt_xuong')
BEGIN
    ALTER TABLE dbo.eqm_mnt WITH NOCHECK
        ADD CONSTRAINT fk_eqm_mnt_xuong FOREIGN KEY (approver_emp_no)
        REFERENCES dbo.xuong_mnt (xuong_no) ON UPDATE CASCADE;
END
GO

-- ============================================================
-- BUOC DU LIEU (ban tu chay sau khi script nay xong):
-- 1. INSERT phan xuong (ma tu dat; MNV phai co san trong emp_mnt;
--    cot nao chua co nguoi thi de NULL):
--
--    INSERT INTO dbo.xuong_mnt
--        (xuong_no, xuong_name, chu_quan_emp_no, pho_quan_1_emp_no, pho_quan_2_emp_no)
--    VALUES
--        ('X1', N'Phan xuong 1', '14398', NULL, NULL),
--        ('X2', N'Phan xuong 2', '14399', NULL, NULL);
--
-- 2. UPDATE thiet bi: approver_emp_no = ma phan xuong
--    (phai INSERT phan xuong TRUOC vi FK moi da bat kiem tra):
--
--    UPDATE dbo.eqm_mnt SET approver_emp_no = 'X1' WHERE approver_emp_no = '14398';
--    UPDATE dbo.eqm_mnt SET approver_emp_no = 'X2' WHERE approver_emp_no = '14399';
-- ============================================================
