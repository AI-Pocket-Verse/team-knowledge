import type { Prisma } from "@prisma/client";
import { extractInternalReferences } from "./extractInternalReferences.js";
import { bindUploadsToArticle } from "./uploadBinding.js";

/**
 * 正文落库后的派生数据同步(必须在写正文的同一个事务里调用;提交后调用方再 markRoleSkillStale):
 * 重建本文的出向引用(ArticleReference,只保留指向未删除文档的)+ 绑定正文里的上传图片。
 * 所有写正文的入口(新建 / PATCH / 恢复版本 / 导入 / 覆盖导入 / 飞书导入 / 一键优化)共用,
 * 避免漏掉某个入口导致「被引用」面板为空、图片被孤儿清理。
 */
export async function syncArticleLinks(
  tx: Prisma.TransactionClient,
  articleId: string,
  body: string,
): Promise<void> {
  await tx.articleReference.deleteMany({ where: { fromArticleId: articleId } });
  const refIds = [...extractInternalReferences(body, articleId)];
  if (refIds.length > 0) {
    const valid = await tx.article.findMany({
      where: { id: { in: refIds }, deletedAt: null },
      select: { id: true },
    });
    if (valid.length > 0) {
      await tx.articleReference.createMany({
        data: valid.map((t) => ({ fromArticleId: articleId, toArticleId: t.id })),
      });
    }
  }
  await bindUploadsToArticle(tx, articleId, body);
}
