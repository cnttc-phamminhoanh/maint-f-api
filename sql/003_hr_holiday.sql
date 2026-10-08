-- ============================================================
-- Quản lý ngày nghỉ bảo trì + tài khoản HR (2026-10-07)
--
-- Quy tắc (user chốt 2026-10-07):
--   * Thứ 7 vẫn đi làm, KHÔNG được cộng bù.
--   * Chỉ Chủ nhật + ngày trong bảng hr_holiday là ngày nghỉ.
--   * Ngày đến hạn bảo trì rơi vào ngày nghỉ -> dời sang ngày làm việc kế tiếp.
--
-- Tạo ra:
--   1. Bảng hr_holiday: ngày nghỉ do phòng HR khai báo
--   2. Function dbo.fn_shift_due: dời ngày hạn qua ngày nghỉ (chủ nhật + hr_holiday)
--   3. Tài khoản HR (emp_no = 'hr01', chức vụ 'hr', PIN mặc định 1234)
-- ============================================================

-- 1) Bảng ngày nghỉ bảo trì
IF OBJECT_ID('dbo.hr_holiday', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.hr_holiday (
    holiday_date DATE NOT NULL,
    holiday_name NVARCHAR(200) NOT NULL DEFAULT '',
    created_emp_no VARCHAR(100) NULL,
    created_at DATETIME2 NOT NULL DEFAULT GETDATE(),
    CONSTRAINT pk_hr_holiday PRIMARY KEY (holiday_date)
  );
END;
GO

-- 2) Function dời ngày hạn bảo trì qua ngày nghỉ
--    Chủ nhật xác định theo mốc tuyệt đối: DATEDIFF(DAY,0,d) % 7 = 6
--    (0 = 1900-01-01 là thứ Hai), không phụ thuộc DATEFIRST của server.
--    Khớp với công thức phía NodeJS (utils cùng logic).
IF OBJECT_ID('dbo.fn_shift_due', 'FN') IS NOT NULL
  DROP FUNCTION dbo.fn_shift_due;
GO
CREATE FUNCTION dbo.fn_shift_due (@d DATE)
RETURNS DATE
AS
BEGIN
  DECLARE @guard INT = 0;
  WHILE @guard < 60 AND (DATEDIFF(DAY, 0, @d) % 7 = 6 OR EXISTS (SELECT 1 FROM hr_holiday WHERE holiday_date = @d))
    BEGIN
      SET @d = DATEADD(DAY, 1, @d);
      SET @guard = @guard + 1;
    END
    RETURN @d;
END;
GO

-- 3) Tài khoản HR để đăng nhập và khai báo ngày nghỉ
--    PIN mặc định: 1234 (scrypt salt:hash, keylen 64) - cần đổi PIN sau lần đăng nhập đầu.
IF NOT EXISTS (SELECT 1 FROM emp_mnt WHERE emp_no = 'hr01')
BEGIN
  INSERT INTO emp_mnt (emp_no, emp_name, pin_hash, face_image_url, position)
  VALUES (
    'hr01',
    N'Bộ phận HR',
    '0269e89dfb9fd51ff7ebae4ae0899252:22512200705d5564ad218432d91f39c60fa04a2e366ad3179a93bb254356156ca97b7d7c6ad6b443fe58218a5fd258b65441f9527e7a7ff3758b73b6e6679952',
    '',
    'hr'
  );
END;
GO
