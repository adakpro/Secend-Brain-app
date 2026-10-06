import type { FastifyPluginAsync } from 'fastify';
import { ProjectBody, TaskBody } from '@sb/contracts';
import { audit } from '@sb/core';
import { type Deps, parse, requireWs, HttpError } from '../context';

const progress = (tasks: number, done: number) => (tasks ? Math.round((done / tasks) * 100) : 0);

export const projectRoutes = (deps: Deps): FastifyPluginAsync => async app => {
  app.get('/projects', async req => {
    const ws = requireWs(req);
    const r = await deps.db.query(
      `SELECT p.*, count(t.*)::int AS tasks, count(t.*) FILTER (WHERE t.done)::int AS done,
         (SELECT count(*)::int FROM sources s WHERE s.project_id=p.id AND s.deleted_at IS NULL) AS sources
       FROM projects p LEFT JOIN tasks t ON t.project_id=p.id WHERE p.workspace_id=$1 GROUP BY p.id ORDER BY p.status='archived', p.updated_at DESC`, [ws.id]);
    return { items: r.rows.map(p => ({ ...p, progress: progress(p.tasks, p.done) })) };
  });

  app.get('/projects/:id', async req => {
    const ws = requireWs(req);
    const id = (req.params as { id: string }).id;
    const p = (await deps.db.query(`SELECT * FROM projects WHERE workspace_id=$1 AND id=$2`, [ws.id, id])).rows[0];
    if (!p) throw new HttpError(404, 'not_found', 'پروژه پیدا نشد.');
    const tasks = (await deps.db.query(`SELECT id, text, section, done, position, updated_at FROM tasks WHERE workspace_id=$1 AND project_id=$2 ORDER BY section, position, created_at`, [ws.id, id])).rows;
    const sources = (await deps.db.query(`SELECT id, title, status, kind FROM sources WHERE workspace_id=$1 AND project_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC`, [ws.id, id])).rows;
    const outputs = (await deps.db.query(`SELECT id, title, template, current_version, updated_at FROM outputs WHERE workspace_id=$1 AND project_id=$2 AND deleted_at IS NULL`, [ws.id, id])).rows;
    const done = tasks.filter(t => t.done).length;
    return { project: { ...p, progress: progress(tasks.length, done), tasksTotal: tasks.length, tasksDone: done }, tasks, sources, outputs };
  });

  app.post('/projects', async req => {
    const ws = requireWs(req, 'member');
    const b = parse(ProjectBody, req.body);
    const r = await deps.db.query(`INSERT INTO projects(workspace_id, title, goal, description, status, color, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ws.id, b.title, b.goal, b.description, b.status, b.color, req.session!.userId]);
    await audit(deps.db, { workspaceId: ws.id, actorUserId: req.session!.userId, action: 'project.created', targetType: 'project', targetId: r.rows[0].id, result: 'success' });
    return { id: r.rows[0].id };
  });

  app.patch('/projects/:id', async req => {
    const ws = requireWs(req, 'member');
    const b = parse(ProjectBody.partial(), req.body);
    const r = await deps.db.query(
      `UPDATE projects SET title=coalesce($3,title), goal=coalesce($4,goal), description=coalesce($5,description), status=coalesce($6,status), color=coalesce($7,color), updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id`,
      [ws.id, (req.params as { id: string }).id, b.title ?? null, b.goal ?? null, b.description ?? null, b.status ?? null, b.color ?? null]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'پروژه پیدا نشد.');
    return { ok: true };
  });

  app.delete('/projects/:id', async req => {
    const ws = requireWs(req, 'admin');
    const r = await deps.db.query(`UPDATE projects SET status='archived', updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id`, [ws.id, (req.params as { id: string }).id]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'پروژه پیدا نشد.');
    return { ok: true, archived: true };
  });

  app.post('/projects/:id/tasks', async req => {
    const ws = requireWs(req, 'member');
    const b = parse(TaskBody, req.body);
    const id = (req.params as { id: string }).id;
    const r = await deps.db.query(`INSERT INTO tasks(workspace_id, project_id, text, section, done, position) VALUES ($1,$2,$3,$4,$5,(SELECT coalesce(max(position),0)+1 FROM tasks WHERE project_id=$2)) RETURNING id`, [ws.id, id, b.text, b.section, b.done]);
    await deps.db.query(`UPDATE projects SET updated_at=now() WHERE id=$1`, [id]);
    return { id: r.rows[0].id };
  });

  app.patch('/projects/:id/tasks/:taskId', async req => {
    const ws = requireWs(req, 'member');
    const { id, taskId } = req.params as { id: string; taskId: string };
    const b = parse(TaskBody.partial(), req.body);
    const r = await deps.db.query(`UPDATE tasks SET text=coalesce($4,text), section=coalesce($5,section), done=coalesce($6,done), updated_at=now() WHERE workspace_id=$1 AND project_id=$2 AND id=$3 RETURNING id`, [ws.id, id, taskId, b.text ?? null, b.section ?? null, b.done ?? null]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'کار پیدا نشد.');
    await deps.db.query(`UPDATE projects SET updated_at=now() WHERE id=$1`, [id]);
    return { ok: true };
  });

  app.delete('/projects/:id/tasks/:taskId', async req => {
    const ws = requireWs(req, 'member');
    const { id, taskId } = req.params as { id: string; taskId: string };
    const r = await deps.db.query(`DELETE FROM tasks WHERE workspace_id=$1 AND project_id=$2 AND id=$3`, [ws.id, id, taskId]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'کار پیدا نشد.');
    return { ok: true };
  });
};
