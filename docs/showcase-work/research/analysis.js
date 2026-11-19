'use strict';

/**
 * 对已去缺测的样本行计算 Pearson 相关、OLS 斜率和截距。
 * 每行: [源行id, 物种, 岛屿, 体重g(x), 喙深mm(y)]
 * 返回 {r, slope, intercept}
 */
window.analyseSample = function (rows) {
    const n = rows.length;
    if (n < 2) return { r: 0, slope: 0, intercept: 0 };

    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
        const x = rows[i][3]; // 体重 g
        const y = rows[i][4]; // 喙深 mm
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    }

    const mx = sx / n;
    const my = sy / n;

    const denom = Math.sqrt((sxx - n * mx * mx) * (syy - n * my * my));

    let r;
    if (denom === 0) {
        r = 0;
    } else {
        r = (sxy - n * mx * my) / denom;
    }

    const ssxx = sxx - n * mx * mx;
    let slope, intercept;
    if (ssxx === 0) {
        slope = 0;
        intercept = my;
    } else {
        slope = (sxy - n * mx * my) / ssxx;
        intercept = my - slope * mx;
    }

    return { r, slope, intercept };
};

/**
 * 中文物种名映射
 */
const CN = { Adelie: '阿德利', Chinstrap: '帽带', Gentoo: '巴布亚' };

/**
 * 按相关方向生成中文读图说明。
 * group: 'All' | 'Adelie' | 'Chinstrap' | 'Gentoo'
 * result: {r, slope, intercept}
 * rows: 用于当前视图的已去缺测样本行（供混合视图时分组复算）
 *
 * 混合视图：用一到两句点出方向反转及物种构成的影响。
 * 分组视图：用中文名和实际有符号系数说明与总体的差异。
 * 只描述关联，不宣称因果机制。
 */
window.interpretSample = function (group, result, rows) {
    // 计算总体（混合）相关，供分组视图对比
    let overall = null;
    if (rows) {
        const allRows = [];
        // 从 window.observations 获取全部去缺测行
        const obs = window.observations;
        if (obs) {
            for (let i = 0; i < obs.length; i++) {
                if (obs[i][3] !== null && obs[i][4] !== null) {
                    allRows.push(obs[i]);
                }
            }
        }
        if (allRows.length >= 2) {
            overall = window.analyseSample(allRows);
        }
    }

    if (group === 'All') {
        // ── 混合视图：计算各物种分组的相关系数
        const speciesGroups = {};
        if (rows) {
            for (let i = 0; i < rows.length; i++) {
                const sp = rows[i][1];
                if (!speciesGroups[sp]) speciesGroups[sp] = [];
                speciesGroups[sp].push(rows[i]);
            }
        }

        const parts = [];
        // 描述总体方向
        if (result.r < -0.03) {
            parts.push('全部物种混合后，体重与喙深呈负向关联（r=' + result.r.toFixed(2) + '）。');
        } else if (result.r > 0.03) {
            parts.push('全部物种混合后，体重与喙深呈正向关联（r=' + result.r.toFixed(2) + '）。');
        } else {
            parts.push('全部物种混合后，体重与喙深未见明显线性趋势（r=' + result.r.toFixed(2) + '）。');
        }

        // 列出各物种方向，指出与总体是否相反
        const speciesOrder = ['Adelie', 'Chinstrap', 'Gentoo'];
        const groupResults = [];
        for (const sp of speciesOrder) {
            if (speciesGroups[sp] && speciesGroups[sp].length >= 2) {
                const gr = window.analyseSample(speciesGroups[sp]);
                groupResults.push({ sp, r: gr.r });
            }
        }

        if (groupResults.length > 0) {
            const signs = groupResults.map(function(gr) {
                return gr.r > 0.03 ? '+' : (gr.r < -0.03 ? '−' : '≈0');
            });
            const allSamePositive = groupResults.every(function(gr) { return gr.r > 0.03; });
            const allSameNeg = groupResults.every(function(gr) { return gr.r < -0.03; });

            if (result.r < -0.03 && allSamePositive) {
                // 典型的 Simpson 反转：总体负，各组皆正
                const details = groupResults.map(function(gr) {
                    return CN[gr.sp] + '（r=' + gr.r.toFixed(2) + '）';
                }).join('、');
                parts.push('但三个物种内部均为正向关联——' + details + '。');
                parts.push('混合后的负向趋势来自物种间体重与喙深的交叉分布，而非个体层面的变化方向。');
            } else if (result.r > 0.03 && allSameNeg) {
                const details = groupResults.map(function(gr) {
                    return CN[gr.sp] + '（r=' + gr.r.toFixed(2) + '）';
                }).join('、');
                parts.push('但三个物种内部均为负向关联——' + details + '。');
                parts.push('混合后的正向趋势来自物种间体重与喙深的交叉分布，而非个体层面的变化方向。');
            } else if (allSamePositive || allSameNeg) {
                const grpDir = allSamePositive ? '正向' : '负向';
                const details = groupResults.map(function(gr) {
                    return CN[gr.sp] + '（r=' + gr.r.toFixed(2) + '）';
                }).join('、');
                parts.push('各物种内部均呈' + grpDir + '关联——' + details + '，方向与混合结果一致。');
            } else {
                const details = groupResults.map(function(gr) {
                    return CN[gr.sp] + '（r=' + gr.r.toFixed(2) + '）';
                }).join('、');
                parts.push('各物种内部方向不完全一致——' + details + '，分组间的分布差异影响了混合趋势。');
            }
        }

        return parts.join(' ');

    } else {
        // ── 分组视图：单个物种
        const label = CN[group] || group;
        let text = '';

        if (result.r > 0.03) {
            text = label + '样本中，体重与喙深呈正向关联（r=' + result.r.toFixed(2) + '，斜率=' + result.slope.toFixed(4) + ' mm/g）。';
        } else if (result.r < -0.03) {
            text = label + '样本中，体重与喙深呈负向关联（r=' + result.r.toFixed(2) + '，斜率=' + result.slope.toFixed(4) + ' mm/g）。';
        } else {
            text = label + '样本中，体重与喙深未见明显的线性趋势（r=' + result.r.toFixed(2) + '）。';
        }

        // 与总体对比
        if (overall) {
            const overallSign = overall.r > 0.03 ? '正向' : (overall.r < -0.03 ? '负向' : '无趋势');
            const groupSign = result.r > 0.03 ? '正向' : (result.r < -0.03 ? '负向' : '无趋势');
            if (overallSign !== groupSign) {
                text += '这一' + groupSign + '方向与全部物种混合后的' + overallSign + '趋势（r=' + overall.r.toFixed(2) + '）相反。';
            } else {
                text += '该' + groupSign + '方向与全部物种混合后的趋势（r=' + overall.r.toFixed(2) + '）一致。';
            }
        }

        text += '此为描述性关联，不说明因果。';
        return text;
    }
};