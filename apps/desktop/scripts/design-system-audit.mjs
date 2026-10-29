import postcss from "postcss";
import ts from "typescript";
import path from "node:path";

// Geometry and placement remain owned by the consumer. Appearance is owned by Ui.tsx.
const appearance = /^(?:color|background(?:-.+)?|border(?:-.+)?|outline(?:-.+)?|box-shadow|text-shadow|font(?:-.+)?|line-height|letter-spacing|text-decoration(?:-.+)?|padding(?:-.+)?|opacity|filter|fill|stroke(?:-.+)?)$/;
const colorProperty = /^(?:color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|inline|block))?(?:-color)?|outline(?:-color)?|(?:box|text)-shadow|text-decoration(?:-color)?|column-rule(?:-color)?|caret-color|fill|stroke|filter)$/;
const components = {
  Button: { className: true, style: true },
  SettingsRow: { className: true, style: true },
  ModalSurface: { className: true, style: true },
  Feedback: { className: false, style: true },
  PageHeader: { className: false, style: false }
};
const namedColors = new Set("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" "));
const cssName = (name) => name.startsWith("--") ? name : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function closingParen(value, start) {
  let depth = 1;
  for (let i = start + 1; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")" && --depth === 0) return i;
  }
  return value.length - 1;
}

/** Inspect CSS values, ignoring quoted strings/URLs and following var() fallbacks. */
export function inspectColor(value, property, variables) {
  const problems = [];
  let remaining = value.replace(/\/\*[\s\S]*?\*\//g, "");
  remaining = remaining.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, " ");
  const functions = /\b(var|url)\(/g;
  let match;
  while ((match = functions.exec(remaining))) {
    const end = closingParen(remaining, match.index + match[0].length - 1);
    if (match[1] === "var") {
      const contents = remaining.slice(match.index + match[0].length, end);
      const comma = contents.indexOf(",");
      const variable = (comma < 0 ? contents : contents.slice(0, comma)).trim();
      if (!variables.has(variable) && comma < 0) problems.push({ code: "unknown-variable", value: variable });
      if (comma >= 0) problems.push(...inspectColor(contents.slice(comma + 1), property, variables));
    }
    remaining = remaining.slice(0, match.index) + " " + remaining.slice(end + 1);
    functions.lastIndex = match.index;
  }
  for (const raw of remaining.matchAll(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/gi)) {
    problems.push({ code: "raw-color", value: raw[0] });
  }
  remaining = remaining.replace(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/gi, " ");
  if (colorProperty.test(property) || property.startsWith("--")) {
    // Dimensions, percentages and neutral CSS syntax are not named colors.
    remaining = remaining.replace(/[-+]?(?:\d*\.)?\d+(?:[a-z]+|%)?/gi, " ");
    remaining = remaining.replace(/\b[a-z][a-z-]*(?=\()/gi, " ");
    for (const word of remaining.matchAll(/[a-z][a-z-]*/gi)) {
      const normalized = word[0].toLowerCase();
      if (namedColors.has(normalized)) problems.push({ code: "raw-color", value: word[0] });
    }
  }
  return problems;
}

// Only a selector's final compound can style the component root. Never confuse
// `.consumer .child` with `.consumer`. Complex functional pseudos stay unverified.
export function targetClasses(selector) {
  if (/:(?:is|where|not|has)\(/.test(selector) || selector.includes("::")) return null;
  const withoutAttributes = selector.replace(/\[[^\]]*\]/g, "");
  const compound = withoutAttributes.trim().split(/[\s>+~]+/).at(-1);
  return [...compound.matchAll(/\.([a-z_][\w-]*)/gi)].map((item) => item[1]);
}

function unwrap(node) {
  while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
  return node;
}

function staticStrings(node, constants, seen = new Set()) {
  node = unwrap(node);
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...staticStrings(node.whenTrue, constants, seen), ...staticStrings(node.whenFalse, constants, seen)];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return staticStrings(node.right, constants, seen);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["cn", "cx", "clsx", "classNames", "twMerge", "twJoin"].includes(node.expression.text)) return node.arguments.flatMap((argument) => staticStrings(argument, constants, seen));
  if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
    const initializer = constants.get(node.text);
    return staticStrings(initializer, constants.at?.(initializer) ?? constants, new Set([...seen, node.text]));
  }
  if (ts.isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const choices = staticStrings(span.expression, constants, seen);
      if (!choices.length) return [node.head.text, ...node.templateSpans.map((part) => part.literal.text)];
      values = values.flatMap((prefix) => choices.map((choice) => prefix + choice + span.literal.text)).slice(0, 64);
    }
    return values;
  }
  return [];
}

function completeClasses(node, constants, seen = new Set()) {
  node = unwrap(node);
  if (!node) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
    const initializer = constants.get(node.text);
    return completeClasses(initializer, constants.at?.(initializer) ?? constants, new Set([...seen, node.text]));
  }
  if (ts.isConditionalExpression(node)) return completeClasses(node.whenTrue, constants, seen) && completeClasses(node.whenFalse, constants, seen);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return completeClasses(node.right, constants, seen);
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => completeClasses(span.expression, constants, seen));
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["cn", "cx", "clsx", "classNames", "twMerge", "twJoin"].includes(node.expression.text)) return node.arguments.every((argument) => completeClasses(argument, constants, seen));
  return false;
}

function objectProperties(node, constants, seen = new Set()) {
  node = unwrap(node);
  if (node && ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
    const initializer = constants.get(node.text);
    return objectProperties(initializer, constants.at?.(initializer) ?? constants, new Set([...seen, node.text]));
  }
  if (!node || !ts.isObjectLiteralExpression(node)) return { properties: [], incomplete: true };
  let properties = [];
  let incomplete = false;
  for (const item of node.properties) {
    if (ts.isSpreadAssignment(item)) {
      const spread = objectProperties(item.expression, constants, seen);
      properties.push(...spread.properties);
      incomplete ||= spread.incomplete;
    } else if (ts.isPropertyAssignment(item) && !ts.isComputedPropertyName(item.name)) {
      properties.push({ name: item.name.text, value: item.initializer, node: item, constants: constants.at?.(item.initializer) ?? constants });
    } else incomplete = true;
  }
  return { properties, incomplete };
}

export function auditDesignSystem({ cssSources, tsxSources, themeFile, uiFile }) {
  const diagnostics = [];
  const coverage = { cssFiles: cssSources.length, tsxFiles: tsxSources.length, complexSelectors: 0, unreadableClassNames: 0, unreadableStyles: 0, unreadableColorValues: 0 };
  const parsedCss = cssSources.map((source) => ({ ...source, ast: postcss.parse(source.text, { from: source.file }) }));
  const parsedTsx = tsxSources.map((source) => ({ ...source, ast: ts.createSourceFile(source.file, source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) }));
  const variables = new Set();
  for (const { ast } of parsedCss) ast.walkDecls((decl) => { if (decl.prop.startsWith("--")) variables.add(decl.prop); });
  for (const { ast } of parsedTsx) {
    const visit = (node) => {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith("--")) variables.add(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const add = (file, line, column, code, message, severity = "error") => diagnostics.push({ file, line, column, code, message, severity });
  for (const { file, ast } of parsedTsx) for (const error of ast.parseDiagnostics) {
    const location = ast.getLineAndCharacterOfPosition(error.start ?? 0);
    add(file, location.line + 1, location.character + 1, "parse-error", ts.flattenDiagnosticMessageText(error.messageText, " "));
  }
  const cssClasses = new Map();
  for (const { file, ast } of parsedCss) {
    ast.walkDecls((decl) => {
      for (const problem of inspectColor(decl.value, decl.prop, variables)) {
        if (problem.code === "raw-color" && file === themeFile) continue;
        add(file, decl.source.start.line, decl.source.start.column, problem.code,
          problem.code === "raw-color" ? `${decl.prop}: ${problem.value} 색상을 테마 변수로 지정하세요.` : `선언되지 않은 CSS 변수 ${problem.value}. 테마 토큰 또는 유효한 fallback을 확인하세요.`);
      }
    });
    ast.walkRules((rule) => {
      const properties = rule.nodes.filter((node) => node.type === "decl" && appearance.test(node.prop)).map((decl) => decl.prop);
      if (!properties.length) return;
      for (const selector of postcss.list.comma(rule.selector)) {
        const classes = targetClasses(selector);
        if (classes === null) { coverage.complexSelectors++; continue; }
        for (const name of classes) {
          if (!cssClasses.has(name)) cssClasses.set(name, []);
          const compound = selector.replace(/\[[^\]]*\]/g, "").trim().split(/[\s>+~]+/).at(-1);
          const tag = compound.match(/^[a-z][\w-]*/i)?.[0];
          const conditional = !/^(?:[a-z][\w-]*)?\.[a-z_][\w-]*$/i.test(selector.trim()) || rule.parent.type === "atrule";
          cssClasses.get(name).push({ file, line: rule.source.start.line, selector, properties, tag, conditional });
        }
        const scopedVariant = /[\s>+~]/.test(selector) && classes.some((name) => /^(primary|secondary|tertiary|destructive|icon)-button$/.test(name));
        if (file !== path.join(path.dirname(themeFile), "design-system.css") && (/(?:\s|>)button(?:[:[.#]|$)/.test(selector) || scopedVariant)) {
          add(file, rule.source.start.line, rule.source.start.column, "scoped-button-review", `${selector}: 조상 selector가 button 외관(${properties.join(", ")})에 영향을 줄 수 있습니다. 실제 공통 Button 적용 여부를 검토하세요.`, "warning");
        }
      }
    });
  }
  for (const { file, ast } of parsedTsx) {
    const imports = new Map();
    const namespaces = new Set();
    const scopes = new Map();
    const bindingNames = (name) => {
      if (ts.isIdentifier(name)) return [name.text];
      if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return name.elements.flatMap((item) => ts.isBindingElement(item) ? bindingNames(item.name) : []);
      return [];
    };
    const gather = (node) => {
      if (ts.isVariableDeclaration(node)) {
        const catchBinding = ts.isCatchClause(node.parent);
        let scope = catchBinding ? node.parent.block : node.parent;
        const blockScoped = node.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let);
        while (!catchBinding && scope && !ts.isSourceFile(scope) && !(ts.isBlock(scope) && (blockScoped || ts.isFunctionLike(scope.parent))) && !(blockScoped && (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)))) scope = scope.parent;
        if (!scopes.has(scope)) scopes.set(scope, new Map());
        for (const name of bindingNames(node.name)) scopes.get(scope).set(name, ts.isIdentifier(node.name) && (node.parent.flags & ts.NodeFlags.Const) ? node.initializer : undefined);
      }
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        let scope = node.parent;
        while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
        if (!scopes.has(scope)) scopes.set(scope, new Map());
        scopes.get(scope).set(node.name.text, undefined);
      }
      ts.forEachChild(node, gather);
    };
    gather(ast);
    const constantsAt = (node) => {
      const ancestors = [];
      for (let parent = node?.parent; parent; parent = parent.parent) ancestors.unshift(parent);
      const constants = new Map();
      for (const ancestor of ancestors) {
        if (ts.isFunctionLike(ancestor)) for (const parameter of ancestor.parameters) for (const name of bindingNames(parameter.name)) constants.set(name, undefined);
        if (ts.isCatchClause(ancestor) && ancestor.variableDeclaration) for (const name of bindingNames(ancestor.variableDeclaration.name)) constants.set(name, undefined);
        for (const [name, value] of scopes.get(ancestor) ?? []) constants.set(name, value);
      }
      constants.at = constantsAt;
      return constants;
    };
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const resolved = path.resolve(path.dirname(file), node.moduleSpecifier.text).replace(/\.js$/, ".tsx");
      if (resolved !== path.resolve(uiFile)) continue;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) imports.set(item.name.text, item.propertyName?.text ?? item.name.text);
    }
    const report = (node, code, message, severity) => {
      const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
      add(file, location.line + 1, location.character + 1, code, message, severity);
    };
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const constants = constantsAt(node);
        let component;
        if (ts.isIdentifier(node.tagName) && !constants.has(node.tagName.text)) component = imports.get(node.tagName.text);
        if (ts.isPropertyAccessExpression(node.tagName) && namespaces.has(node.tagName.expression.getText(ast)) && !constants.has(node.tagName.expression.getText(ast))) component = node.tagName.name.text;
        const contract = file === uiFile ? undefined : components[component];
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) {
            if (contract) report(attribute, "unreadable-props", `${component}의 props spread를 정적으로 검사하지 못했습니다.`, "warning");
            continue;
          }
          const name = attribute.name.getText(ast);
          const expression = attribute.initializer && ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer;
          if (name === "className" && contract?.className) {
            const values = staticStrings(expression, constants);
            if (!completeClasses(expression, constants)) coverage.unreadableClassNames++;
            const classes = new Set(values.flatMap((value) => value.split(/\s+/)).filter(Boolean));
            const variantAttribute = node.attributes.properties.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText(ast) === "variant");
            const variant = staticStrings(variantAttribute?.initializer, constants)[0] ?? "secondary";
            for (const name of classes) {
              if (component === "Button" && name === `${variant}-button`) continue;
              for (const declaration of cssClasses.get(name) ?? []) {
                const rootTag = component === "Button" ? "button" : "div";
                if (declaration.tag && declaration.tag !== rootTag) continue;
                report(attribute, declaration.conditional ? "component-restyle-review" : "component-restyle", `${component}의 className '${name}'가 ${declaration.properties.join(", ")} 외관을 지정합니다 (${declaration.file}:${declaration.line}, ${declaration.selector}).${declaration.conditional ? " Selector 적용 조건을 검토하세요." : ""}`, declaration.conditional ? "warning" : "error");
              }
            }
          }
          if (name === "style" && expression) {
            const styles = objectProperties(expression, constants);
            if (styles.incomplete) {
              coverage.unreadableStyles++;
              if (contract?.style) report(attribute, "unreadable-style", `${component}의 동적 style 또는 spread를 정적으로 검사하지 못했습니다.`, "warning");
            }
            for (const property of styles.properties) {
              const propertyName = cssName(property.name);
              if (contract?.style && appearance.test(propertyName)) report(property.node, "component-restyle", `${component}의 inline ${property.name} 외관을 소비처에서 덮어쓰지 마세요.`);
              const values = staticStrings(property.value, property.constants);
              if (!values.length && (colorProperty.test(propertyName) || propertyName.startsWith("--")) && !ts.isNumericLiteral(unwrap(property.value))) coverage.unreadableColorValues++;
              for (const value of values) for (const problem of inspectColor(value, propertyName, variables)) {
                report(property.node, problem.code, problem.code === "raw-color" ? `inline ${property.name}: ${problem.value} 색상을 테마 변수로 지정하세요.` : `선언되지 않은 CSS 변수 ${problem.value}.`);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.code.localeCompare(b.code));
  return { diagnostics, coverage };
}
