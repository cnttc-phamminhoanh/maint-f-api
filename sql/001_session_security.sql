-- ============================================================
-- Bao mat local-api: bang phien dang nhap + bang chan do PIN
-- Chay mot lan tren SQL Server cua ban (trước khi khởi động API bản mới)
-- ============================================================

IF OBJECT_ID('dbo.emp_mnt_session', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.emp_mnt_session (
        token_hash  VARCHAR(64)  NOT NULL PRIMARY KEY,   -- SHA-256 hex cua token
        emp_no      VARCHAR(100) NOT NULL,
        expires_at  DATETIME2    NOT NULL,
        created_at  DATETIME2    NOT NULL DEFAULT GETDATE(),  -- chuan gio HK, khop GETDATE()/expires_at
        CONSTRAINT fk_emp_mnt_session_emp
            FOREIGN KEY (emp_no) REFERENCES dbo.emp_mnt(emp_no)
            ON UPDATE CASCADE ON DELETE CASCADE
    );
    CREATE INDEX idx_emp_mnt_session_emp_no ON dbo.emp_mnt_session(emp_no);
END;
GO

IF OBJECT_ID('dbo.emp_mnt_login_lock', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.emp_mnt_login_lock (
        emp_no       VARCHAR(100) NOT NULL PRIMARY KEY,
        fail_count   INT          NOT NULL DEFAULT 0,
        locked_until DATETIME2    NULL,
        CONSTRAINT fk_emp_mnt_login_lock_emp
            FOREIGN KEY (emp_no) REFERENCES dbo.emp_mnt(emp_no)
            ON UPDATE CASCADE ON DELETE CASCADE
    );
END;
GO
