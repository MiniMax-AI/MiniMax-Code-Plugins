# wgcna.R —— WGCNA 加权共表达网络分析（软阈值/模块/模块-分组相关/特征向量网络/Cytoscape 导出）
# 输入: expr(gene_expression.csv: gene_id + 各样本), sample_group(需 group_name)
# params: expr, sample_group, outdir, power(0=自动, 否则手动), min_module_size(30),
#         merge_cut(0.25), network_type("unsigned"|"signed"), min_mean(1),
#         max_genes(方差过滤上限,默认3000), export_module(可选:导出该颜色模块的 Cytoscape 边表),
#         tomplot(bool,默认F,较慢), n_threads(0=全部), dpi(300)
.args <- commandArgs(trailingOnly = TRUE)
source(.args[[2]])
p <- rgraph_load_params()
rgraph_library(c("WGCNA", "dplyr"))
options(stringsAsFactors = FALSE)

expr <- rgraph_read_matrix(p$expr)
sg <- rgraph_read_sample_group(p$sample_group)
rgraph_check_samples(expr, sg$sample_name)
rownames(expr) <- expr$gene_id
ge <- expr[, sg$sample_name, drop = FALSE]
ge[is.na(ge)] <- 0
# 低表达过滤 + 方差 top 过滤（控制规模/耗时）
ns <- ncol(ge)
ge <- ge[rowSums(ge == 0) < ns * 0.5 & rowMeans(ge) >= rgraph_opt(p, "min_mean", 1), , drop = FALSE]
maxg <- rgraph_opt(p, "max_genes", 3000)
if (nrow(ge) > maxg) ge <- ge[order(apply(ge, 1, var), decreasing = TRUE)[seq_len(maxg)], , drop = FALSE]
datExpr <- as.matrix(t(ge)); mode(datExpr) <- "numeric"
nGenes <- ncol(datExpr); nSamples <- nrow(datExpr)

nt <- rgraph_opt(p, "n_threads", 0)
if (is.numeric(nt) && nt >= 2) WGCNA::enableWGCNAThreads(nThreads = nt) else try(WGCNA::allowWGCNAThreads(), silent = TRUE)
net_type <- rgraph_opt(p, "network_type", "unsigned")

# ---- 软阈值 ----------------------------------------------------------------
powers <- 1:20
sft <- WGCNA::pickSoftThreshold(datExpr, powerVector = powers, verbose = 0, networkType = net_type)
rgraph_save_base(p$outdir, "01.power", function() {
  par(mfrow = c(1, 2)); cex1 <- 0.9
  plot(sft$fitIndices[, 1], -sign(sft$fitIndices[, 3]) * sft$fitIndices[, 2],
       xlab = "Soft Threshold (power)", ylab = "Scale Free Topology Model Fit, signed R^2",
       type = "n", main = "Scale independence")
  text(sft$fitIndices[, 1], -sign(sft$fitIndices[, 3]) * sft$fitIndices[, 2], labels = powers, cex = cex1, col = "red")
  abline(h = 0.85, col = "red")
  plot(sft$fitIndices[, 1], sft$fitIndices[, 5], xlab = "Soft Threshold (power)",
       ylab = "Mean Connectivity", type = "n", main = "Mean connectivity")
  text(sft$fitIndices[, 1], sft$fitIndices[, 5], labels = powers, cex = cex1, col = "red")
}, width = 12, height = 7, dpi = rgraph_opt(p, "dpi", 300))
power <- rgraph_opt(p, "power", 0)
if (is.null(power) || power <= 0) power <- if (!is.na(sft$powerEstimate)) sft$powerEstimate else 6
cat("RGRAPH_INFO: power=", power, "\n")

# ---- 构建网络 --------------------------------------------------------------
net <- WGCNA::blockwiseModules(datExpr, corType = "pearson", power = power,
        networkType = net_type, TOMType = net_type,
        deepSplit = 2, minModuleSize = rgraph_opt(p, "min_module_size", 30),
        mergeCutHeight = rgraph_opt(p, "merge_cut", 0.25), numericLabels = TRUE,
        maxBlockSize = nGenes + 1, saveTOMs = FALSE, nThreads = 0)
moduleColors <- WGCNA::labels2colors(net$colors)

rgraph_save_base(p$outdir, "02.dendrogram", function() {
  WGCNA::plotDendroAndColors(net$dendrograms[[1]], moduleColors[net$blockGenes[[1]]],
    "Module colors", dendroLabels = FALSE, hang = 0.03, addGuide = TRUE, guideHang = 0.05)
}, width = 9, height = 5, dpi = rgraph_opt(p, "dpi", 300))

rgraph_write_csv(data.frame(gene_id = colnames(datExpr), Module = moduleColors),
                 p$outdir, "gene_module")

# ---- 模块-分组相关性 -------------------------------------------------------
MEs <- WGCNA::orderMEs(WGCNA::moduleEigengenes(datExpr, moduleColors)$eigengenes)
gfac <- as.factor(sg$group_name[match(rownames(datExpr), sg$sample_name)])
gdesign <- model.matrix(~ gfac - 1); colnames(gdesign) <- levels(gfac)
mgc <- cor(MEs, gdesign, use = "p")
mgp <- WGCNA::corPvalueStudent(mgc, nSamples)
txt <- paste(signif(mgc, 2), "\n(", signif(mgp, 1), ")", sep = ""); dim(txt) <- dim(mgc)
rgraph_save_base(p$outdir, "05.module-group", function() {
  par(mar = c(8, 10, 4, 4))
  WGCNA::labeledHeatmap(Matrix = mgc, xLabels = colnames(gdesign), yLabels = names(MEs),
    ySymbols = names(MEs), colorLabels = FALSE, colors = WGCNA::blueWhiteRed(50),
    textMatrix = txt, setStdMargins = FALSE, cex.text = 0.7, zlim = c(-1, 1),
    main = "Module-group relationships")
}, width = 10, height = 8, dpi = rgraph_opt(p, "dpi", 300))

# ---- MM(基因-模块隶属度) + geneInfo ---------------------------------------
modNames <- substring(names(MEs), 3)
MM <- as.data.frame(cor(datExpr, MEs, use = "p")); names(MM) <- paste0("MM", modNames)
MMp <- as.data.frame(WGCNA::corPvalueStudent(as.matrix(MM), nSamples)); names(MMp) <- paste0("p.MM", modNames)
geneInfo <- cbind(gene_id = colnames(datExpr), Module = moduleColors, MM, MMp)
rgraph_write_csv(geneInfo, p$outdir, "geneInfo")

# ---- 特征向量邻接热图 ------------------------------------------------------
mecor <- cor(MEs, use = "p")
rgraph_save_base(p$outdir, "08.eigengene_adjacency", function() {
  par(mar = c(8, 10, 4, 3))
  WGCNA::labeledHeatmap(Matrix = mecor, xLabels = names(MEs), yLabels = names(MEs),
    ySymbols = names(MEs), colorLabels = FALSE, colors = WGCNA::blueWhiteRed(50),
    setStdMargins = FALSE, cex.text = 0.7, zlim = c(-1, 1), main = "Eigengene adjacency")
}, width = 8, height = 7, dpi = rgraph_opt(p, "dpi", 300))

# ---- 可选: TOM 网络热图（较慢）--------------------------------------------
if (isTRUE(rgraph_opt(p, "tomplot", FALSE))) {
  TOM <- WGCNA::TOMsimilarityFromExpr(datExpr, power = power, networkType = net_type)
  nSelect <- min(400, nGenes); set.seed(10); sel <- sample(nGenes, nSelect)
  selTOM <- (1 - TOM)[sel, sel]; selTree <- hclust(as.dist(selTOM), method = "average")
  plotDiss <- selTOM^7; diag(plotDiss) <- NA
  rgraph_save_base(p$outdir, "06.network_heatmap",
    function() WGCNA::TOMplot(plotDiss, selTree, moduleColors[sel], main = "Network heatmap (selected genes)"),
    width = 8, height = 8, dpi = rgraph_opt(p, "dpi", 300))
  # 可选 Cytoscape 导出（与 rgraph_network edge 模式串联）
  em <- rgraph_opt(p, "export_module", NULL)
  if (is.null(em)) {   # 未指定时自动取最大非-grey 模块
    tb <- sort(table(moduleColors[moduleColors != "grey"]), decreasing = TRUE)
    if (length(tb) > 0) em <- names(tb)[1]
  }
  if (!is.null(em)) {
    inMod <- moduleColors == em; probes <- colnames(datExpr)[inMod]
    modTOM <- TOM[inMod, inMod]; dimnames(modTOM) <- list(probes, probes)
    ef <- file.path(p$outdir, paste0("Cytoscape_edges_", em, ".txt"))
    nf <- file.path(p$outdir, paste0("Cytoscape_nodes_", em, ".txt"))
    WGCNA::exportNetworkToCytoscape(modTOM, weighted = TRUE,
             threshold = rgraph_opt(p, "export_threshold", 0.1),
             nodeNames = probes, nodeAttr = moduleColors[inMod],
             edgeFile = ef, nodeFile = nf)
    rgraph_emit(ef); rgraph_emit(nf)
    cat("RGRAPH_INFO: exported module=", em, "nodes=", length(probes), "\n")
  }
}
cat("RGRAPH_DONE: wgcna genes=", nGenes, "samples=", nSamples, "modules=",
    length(unique(moduleColors)), "\n")
