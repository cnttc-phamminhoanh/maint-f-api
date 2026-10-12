-- ============================================================
-- 005_push.sql
-- Bang token day thong bao (Firebase Cloud Messaging) va nhat ky gui.
-- LUAT gio cua du an: moi cot thoi gian dung GETDATE() (dong ho server DB),
-- cam SYSUTCDATETIME / GETUTCDATE.
-- Chay tren SQL Server truoc khi deploy ban local-api moi.
-- ============================================================

IF OBJECT_ID('dbo.emp_push_token', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.emp_push_token (
        id           INT IDENTITY(1,1) NOT NULL,
        emp_no       VARCHAR(20) NOT NULL,          -- MNV nguoi nhan
        fcm_token    NVARCHAR(500) NOT NULL,
        device_label NVARCHAR(200) NULL,            -- ten thiet bi dang ky (tuy chon)
        is_active    BIT NOT NULL CONSTRAINT df_emp_push_token_active DEFAULT 1,
        created_at   DATETIME NOT NULL CONSTRAINT df_emp_push_token_created DEFAULT GETDATE(),
        last_seen_at DATETIME NOT NULL CONSTRAINT df_emp_push_token_seen DEFAULT GETDATE(),
        CONSTRAINT pk_emp_push_token PRIMARY KEY (id),
        CONSTRAINT uq_emp_push_token_fcm UNIQUE (fcm_token)
    );
    CREATE INDEX ix_emp_push_token_emp ON dbo.emp_push_token (emp_no) INCLUDE (fcm_token);
END
GO

IF OBJECT_ID('dbo.push_log', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.push_log (
        id               INT IDENTITY(1,1) NOT NULL,
        event_type       VARCHAR(40) NOT NULL,      -- submitted / approved / rejected / test
        equ_no           VARCHAR(50) NULL,
        actor_emp_no     VARCHAR(20) NULL,
        recipient_emp_no VARCHAR(20) NOT NULL,
        status           VARCHAR(10) NOT NULL,      -- 'sent' | 'failed'
        error            NVARCHAR(500) NULL,
        created_at       DATETIME NOT NULL CONSTRAINT df_push_log_created DEFAULT GETDATE(),
        CONSTRAINT pk_push_log PRIMARY KEY (id),
        CONSTRAINT ck_push_log_status CHECK (status IN ('sent', 'failed'))
    );
    CREATE INDEX ix_push_log_created ON dbo.push_log (created_at DESC);
END
GO
