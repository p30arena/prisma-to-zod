import {
  Project,
  SyntaxKind,
  InterfaceDeclaration,
  TypeAliasDeclaration,
  EnumDeclaration,
  ModuleDeclaration,
  Type,
} from "ts-morph";
import { writeFileSync } from "fs";

// A lookup for enum types by their name (as declared in the Prisma types)
const enumSchemas = new Map<string, string>();

// A set of property names we want to filter out (e.g. Array prototype methods)
const arrayMethodNames = new Set([
  "pop",
  "push",
  "concat",
  "join",
  "reverse",
  "shift",
  "slice",
  "sort",
  "splice",
  "unshift",
  "indexOf",
  "lastIndexOf",
  "every",
  "some",
  "forEach",
  "find",
  "findIndex",
  "filter",
  "map",
  "reduce",
  "reduceRight",
  "includes",
  "flat",
  "flatMap",
]);

/**
 * Generates a Zod schema for an enum declaration.
 *
 * It produces code like:
 *   export const enum_MyEnumSchema = z.enum(["A", "B", "C"] as const);
 *
 * And stores the mapping from the enum's name (e.g. "MyEnum") to the variable name "enum_MyEnumSchema".
 */
function generateEnumSchema(enumDecl: EnumDeclaration): string {
  const enumName = enumDecl.getName();
  const schemaVar = `enum_${enumName}Schema`;

  // Gather enum member values. This assumes string enum members.
  const members = enumDecl.getMembers().map((m) => m.getName());

  const schemaCode = `export const ${schemaVar} = z.enum([${members
    .map((m) => `"${m}"`)
    .join(", ")}] as const);\n\n`;
  // Store the mapping.
  enumSchemas.set(enumName, schemaVar);
  return schemaCode;
}

/**
 * Recursively maps a ts-morph Type to a Zod schema string.
 * A WeakSet is used to detect and break recursive cycles.
 */
function mapTypeToZod(type: Type, visited = new WeakSet<Type>()): string {
  // Break recursion if this type has already been seen.
  if (visited.has(type)) {
    console.warn("Recursive type detected for: " + type.getText());
    return "z.any()";
  }
  visited.add(type);

  // *** NEW JSON CHECK ***
  // If the type text includes "Json" (e.g. "Json", "Prisma.JsonValue", etc.), simply return z.any()
  if (type.getText().includes("Json")) {
    return "z.any()";
  }

  // Check if the type text contains a reference to $Enums.
  const typeText = type.getText();
  const enumMatch = typeText.match(/\$Enums\.(\w+)/);
  if (enumMatch) {
    const enumName = enumMatch[1]; // e.g. "enum_lang"
    if (enumSchemas.has(enumName)) {
      return enumSchemas.get(enumName)!;
    } else {
      console.warn(`Enum ${enumName} referenced in $Enums not found in enumSchemas map.`);
    }
  }

  // Also check the alias symbol.
  const aliasSymbol = type.getAliasSymbol();
  if (aliasSymbol) {
    const aliasName = aliasSymbol.getName();
    if (enumSchemas.has(aliasName)) {
      return enumSchemas.get(aliasName)!;
    }
  }

  // Check the direct symbol.
  const symbol = type.getSymbol();
  if (symbol) {
    const symName = symbol.getName();
    if (enumSchemas.has(symName)) {
      return enumSchemas.get(symName)!;
    }
  }

  // Primitive types
  if (type.isString()) return "z.string()";
  if (type.isNumber()) return "z.number()";
  if (type.isBoolean()) return "z.boolean()";
  if (type.getText() === "Date") return "z.date()";
  if (type.getText() === "bigint") return "z.bigint()";

  // Array types (e.g., string[])
  const arrayElementType = type.getArrayElementType();
  if (arrayElementType) {
    return `z.array(${mapTypeToZod(arrayElementType, visited)})`;
  }

  // Union types (including unions with null)
  if (type.isUnion()) {
    const unionTypes = type.getUnionTypes();

    // Check if this union is an inline enum (all members are string literals)
    if (unionTypes.every((t) => t.isStringLiteral())) {
      const aliasSym = type.getAliasSymbol();
      if (aliasSym && enumSchemas.has(aliasSym.getName())) {
        return enumSchemas.get(aliasSym.getName())!;
      }
      const values = unionTypes.map((t) => t.getLiteralValue() as string);
      return `z.enum([${values.map((v) => `"${v}"`).join(", ")}] as const)`;
    }

    // Handle unions that include null.
    const hasNull = unionTypes.some((t) => t.isNull());
    if (hasNull) {
      const nonNullTypes = unionTypes.filter((t) => !t.isNull());
      if (nonNullTypes.length === 1) {
        return `${mapTypeToZod(nonNullTypes[0], visited)}.nullable()`;
      } else {
        const unionStrs = nonNullTypes.map((t) => mapTypeToZod(t, visited));
        return `z.union([${unionStrs.join(", ")}]).nullable()`;
      }
    }

    // Otherwise, a union of different types.
    const unionStrs = unionTypes.map((t) => mapTypeToZod(t, visited));
    return `z.union([${unionStrs.join(", ")}])`;
  }

  // If the type is an object, try to generate an inline z.object schema if it has properties.
  if (type.isObject()) {
    const properties = type.getProperties();
    if (properties.length > 0) {
      let inner = "z.object({\n";
      properties.forEach((prop) => {
        const propName = prop.getName();
        // Filter out "weird" internal properties and array prototype methods.
        if (propName.startsWith("__@") || arrayMethodNames.has(propName)) return;
        const decls = prop.getDeclarations();
        if (decls.length > 0) {
          const propType = decls[0].getType();
          // Heuristic for optional properties.
          const isOptional =
            (decls[0].getKind() === SyntaxKind.PropertySignature &&
              (decls[0] as any).hasQuestionToken?.()) ||
            propType.getText().includes("undefined");
          inner += `  ${propName}: ${mapTypeToZod(propType, visited)}${isOptional ? ".optional()" : ""},\n`;
        }
      });
      inner += "})";
      return inner;
    }
  }

  // Fallback.
  return "z.any()";
}

/**
 * Generates a Zod schema from an interface declaration.
 */
function generateZodSchemaFromInterface(interfaceDecl: InterfaceDeclaration): string {
  const interfaceName = interfaceDecl.getName();
  let schema = `export const ${interfaceName}Schema = z.object({\n`;
  interfaceDecl.getProperties().forEach((prop) => {
    const propName = prop.getName();
    // Skip internal/array methods.
    if (propName.startsWith("__@") || arrayMethodNames.has(propName)) return;
    const isOptional = prop.hasQuestionToken();
    const propType = prop.getType();
    schema += `  ${propName}: ${mapTypeToZod(propType)}${isOptional ? ".optional()" : ""},\n`;
  });
  schema += `});\n\n`;
  return schema;
}

/**
 * Generates a Zod schema from a type alias declaration.
 */
function generateZodSchemaFromTypeAlias(typeAliasDecl: TypeAliasDeclaration): string {
  const typeName = typeAliasDecl.getName();
  const type = typeAliasDecl.getType();
  if (type.isObject()) {
    const properties = type.getProperties();
    if (properties.length > 0) {
      let schema = `export const ${typeName}Schema = z.object({\n`;
      properties.forEach((prop) => {
        const propName = prop.getName();
        if (propName.startsWith("__@") || arrayMethodNames.has(propName)) return;
        const decls = prop.getDeclarations();
        if (decls.length > 0) {
          const propType = decls[0].getType();
          const isOptional =
            (decls[0].getKind() === SyntaxKind.PropertySignature &&
              (decls[0] as any).hasQuestionToken?.()) ||
            propType.getText().includes("undefined");
          schema += `  ${propName}: ${mapTypeToZod(propType)}${isOptional ? ".optional()" : ""},\n`;
        }
      });
      schema += `});\n\n`;
      return schema;
    }
  }
  const zodType = mapTypeToZod(type);
  return `export const ${typeName}Schema = ${zodType};\n\n`;
}

// Initialize ts-morph with your tsconfig.
const project = new Project({
  tsConfigFilePath: "./tsconfig.json",
});

// Load the Prisma client types file (adjust path as needed)
const prismaFile = project.getSourceFile("./client/index.d.ts");
if (!prismaFile) {
  console.error("Prisma client types file not found!");
  process.exit(1);
}

// Start building the output with the Zod import.
let output = `import { z } from "zod";\n\n`;

// Process namespace declarations (look for the $Enums namespace)
// Use getDescendantsOfKind to get ModuleDeclaration nodes and remove any surrounding quotes.
const namespaceDeclarations = prismaFile
  .getDescendantsOfKind(SyntaxKind.ModuleDeclaration)
  .filter((decl: ModuleDeclaration) =>
    decl.getName().replace(/['"]/g, "") === "$Enums"
  );

namespaceDeclarations.forEach((ns: ModuleDeclaration) => {
  // Process classic enum declarations (if any)
  ns.getDescendantsOfKind(SyntaxKind.EnumDeclaration).forEach((enumDecl: EnumDeclaration) => {
    output += generateEnumSchema(enumDecl);
  });
  // Process type aliases that represent enums (unions of string literals)
  ns.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration).forEach((ta) => {
    const unionTypes = ta.getType().getUnionTypes();
    if (unionTypes.length > 0 && unionTypes.every(t => t.isStringLiteral())) {
      const enumName = ta.getName();
      const schemaVar = `enum_${enumName}Schema`;
      const values = unionTypes.map(t => t.getLiteralValue() as string);
      const schemaCode = `export const ${schemaVar} = z.enum([${values.map(v => `"${v}"`).join(", ")}] as const);\n\n`;
      enumSchemas.set(enumName, schemaVar);
      output += schemaCode;
    }
  });
});

// Process top-level exported declarations.
const exportedDeclarations = prismaFile.getExportedDeclarations();
exportedDeclarations.forEach((decls, name) => {
  // Filter out declarations unlikely to be models.
  if (
    name.startsWith("Prisma") ||
    name.endsWith("Input") ||
    name.endsWith("Args") ||
    name.endsWith("Payload") ||
    name.startsWith("_")
  ) {
    return;
  }
  decls.forEach((decl) => {
    if (decl.getKind() === SyntaxKind.InterfaceDeclaration) {
      output += generateZodSchemaFromInterface(decl as InterfaceDeclaration);
    } else if (decl.getKind() === SyntaxKind.TypeAliasDeclaration) {
      output += generateZodSchemaFromTypeAlias(decl as TypeAliasDeclaration);
    }
  });
});

// Write the generated schemas to a file.
writeFileSync("prisma-zod-schemas.ts", output);
console.log("Generated prisma-zod-schemas.ts");
