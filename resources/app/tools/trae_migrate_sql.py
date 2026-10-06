#!/usr/bin/env python3
"""TraeHop 会话迁移 SQL 引擎（仅标准库 sqlite3，操作已解密的明文库）。

用法:
  python trae_migrate_sql.py migrate <plain_db> <from_user> <to_user>
  python trae_migrate_sql.py verify <plain_db> <to_user>   # 旧 session_id 从 stdin 逐行读入

stdout 逐行输出日志，最后一行输出 "__RESULT__ {json}"。
"""
import json
import os
import sqlite3
import struct
import sys
import time


def emit(msg):
    print(msg, flush=True)


def result(payload):
    print("__RESULT__ " + json.dumps(payload, ensure_ascii=False), flush=True)


def sid_columns(db):
    out = []
    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        if name.startswith("sqlite_"):
            continue
        for col in db.execute('PRAGMA table_info("%s")' % name).fetchall():
            if "session_id" in col[1]:
                out.append((name, col[1]))
    return out


def sessions_of(db, user_id):
    return {r[0] for r in db.execute("""
        SELECT DISTINCT cs.session_id FROM chat_session cs
        JOIN session_project sp ON sp.session_id = cs.session_id
        JOIN project p ON p.project_id = sp.project_id
        WHERE p.user_id = ?
    """, (user_id,))}


def migrate_projects(db, from_user, to_user):
    src = db.execute(
        "SELECT project_id, name, absolute_path FROM project WHERE user_id = ?",
        (from_user,)).fetchall()
    if not src:
        return None
    dst_by_path = {p[2]: p for p in db.execute(
        "SELECT project_id, name, absolute_path FROM project WHERE user_id = ?",
        (to_user,)).fetchall()}

    db.execute("BEGIN")
    pid_map = {}
    retargeted = reowned = 0
    try:
        for pid, name, apath in src:
            dst = dst_by_path.get(apath)
            if dst:
                db.execute("UPDATE session_project SET project_id = ? WHERE project_id = ?",
                           (dst[0], pid))
                db.execute("UPDATE chat_session SET project_id = ? WHERE project_id = ?",
                           (dst[0], pid))
                pid_map[pid] = dst[0]
                db.execute("DELETE FROM project WHERE project_id = ?", (pid,))
                retargeted += 1
            else:
                db.execute("UPDATE project SET user_id = ? WHERE project_id = ?",
                           (to_user, pid))
                reowned += 1
        for old_pid, new_pid in pid_map.items():
            db.execute(
                "UPDATE local_artifact SET source_project_id = ? "
                "WHERE source_project_id = ? AND user_id = ?",
                (new_pid, old_pid, from_user))
        # (user_id, source_project_id, entry_key) 唯一：目标账号已有同键产物（曾切换过账号产生）时，
        # 无条件 UPDATE 会撞约束；保留目标现有行，源冲突行直接删除
        artifacts = db.execute(
            "UPDATE local_artifact SET user_id = ? WHERE user_id = ? AND NOT EXISTS ("
            "SELECT 1 FROM local_artifact t WHERE t.user_id = ? "
            "AND t.source_project_id = local_artifact.source_project_id "
            "AND t.entry_key = local_artifact.entry_key)",
            (to_user, from_user, to_user)).rowcount
        db.execute("DELETE FROM local_artifact WHERE user_id = ?", (from_user,))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"retargeted": retargeted, "reowned": reowned, "artifacts": artifacts}


def new_object_id(existing):
    while True:
        oid = (struct.pack(">I", int(time.time())) + os.urandom(8)).hex()
        if oid not in existing:
            existing.add(oid)
            return oid


def reassign_sids(db, old_ids):
    cols = sid_columns(db)
    existing = {r[0] for r in db.execute("SELECT session_id FROM chat_session")}
    mapping = {old: new_object_id(existing) for old in old_ids}

    db.execute("BEGIN")
    try:
        for old, new in mapping.items():
            for t, c in cols:
                db.execute(
                    'UPDATE "%s" SET "%s" = replace("%s", ?, ?) WHERE "%s" LIKE ?'
                    % (t, c, c, c),
                    (old, new, "%" + old + "%"))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return mapping


def leak_count(db, old_ids):
    leaks = 0
    cols = sid_columns(db)
    for old in old_ids:
        for t, c in cols:
            leaks += db.execute(
                'SELECT COUNT(*) FROM "%s" WHERE "%s" LIKE ?' % (t, c),
                ("%" + old + "%",)).fetchone()[0]
    return leaks


def do_migrate(plain, from_user, to_user):
    db = sqlite3.connect(plain)
    try:
        ok = db.execute("PRAGMA integrity_check(3)").fetchone()[0]
        if ok != "ok":
            return {"ok": False, "error": "迁移前 integrity=%s" % ok}
        emit("  迁移前 integrity=ok")

        native = sessions_of(db, to_user)
        emit("  目标账号原生会话 %d 个" % len(native))

        stats = migrate_projects(db, from_user, to_user)
        if stats is None:
            return {"ok": False, "error": "当前账号在本地库中没有项目"}
        emit("  项目改挂 %d / 转归属 %d，本地产物 %d 条"
             % (stats["retargeted"], stats["reowned"], stats["artifacts"]))

        migrated = sessions_of(db, to_user) - native
        emit("  迁入会话 %d 个" % len(migrated))

        mapping = {}
        if migrated:
            mapping = reassign_sids(db, sorted(migrated))
            emit("  已重分配 session_id %d 个（防服务端 4011）" % len(mapping))
            if leak_count(db, mapping.keys()):
                return {"ok": False, "error": "替换后旧 session_id 有残留"}

        dangling = db.execute("""
            SELECT COUNT(*) FROM chat_session cs
            LEFT JOIN project p ON p.project_id = cs.project_id
            WHERE p.project_id IS NULL""").fetchone()[0]
        mismatch = db.execute("""
            SELECT COUNT(*) FROM chat_session cs
            JOIN session_project sp ON sp.session_id = cs.session_id
            WHERE cs.project_id != sp.project_id""").fetchone()[0]
        residue = db.execute(
            "SELECT COUNT(*) FROM project WHERE user_id = ?", (from_user,)).fetchone()[0]
        art_residue = db.execute(
            "SELECT COUNT(*) FROM local_artifact WHERE user_id = ?",
            (from_user,)).fetchone()[0]
        if dangling or mismatch or residue or art_residue:
            return {"ok": False,
                    "error": "验证失败 悬空=%d 不一致=%d 源残留=%d/%d"
                             % (dangling, mismatch, residue, art_residue)}

        gone = [s for s in native if not db.execute(
            "SELECT 1 FROM chat_session WHERE session_id = ?", (s,)).fetchone()]
        if gone:
            return {"ok": False, "error": "目标原生会话缺失 %d 个" % len(gone)}

        ok = db.execute("PRAGMA integrity_check(3)").fetchone()[0]
        if ok != "ok":
            return {"ok": False, "error": "迁移后 integrity=%s" % ok}

        r = {"ok": True, "native": len(native), "migrated": len(migrated),
             "mapping": mapping}
        r.update(stats)
        return r
    finally:
        db.close()


def do_verify(plain, to_user, old_ids):
    db = sqlite3.connect(plain)
    try:
        ok = db.execute("PRAGMA integrity_check(3)").fetchone()[0]
        if ok != "ok":
            return {"ok": False, "error": "回验 integrity=%s" % ok}
        leaks = leak_count(db, old_ids)
        if leaks:
            return {"ok": False, "error": "回验旧 session_id 残留 %d 处" % leaks}
        cnt = db.execute("""
            SELECT COUNT(DISTINCT cs.session_id) FROM chat_session cs
            JOIN session_project sp ON sp.session_id = cs.session_id
            JOIN project p ON p.project_id = sp.project_id
            WHERE p.user_id = ?""", (to_user,)).fetchone()[0]
        return {"ok": True, "sessions": cnt}
    finally:
        db.close()


def main():
    args = sys.argv[1:]
    if len(args) >= 4 and args[0] == "migrate":
        r = do_migrate(args[1], args[2], args[3])
    elif len(args) >= 3 and args[0] == "verify":
        old_ids = [ln.strip() for ln in sys.stdin if ln.strip()]
        r = do_verify(args[1], args[2], old_ids)
    else:
        r = {"ok": False, "error": "参数错误"}
    result(r)
    sys.exit(0 if r.get("ok") else 1)


if __name__ == "__main__":
    main()
