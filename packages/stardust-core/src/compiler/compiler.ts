import { CompileError } from "../common";
import { Dictionary, attemptName } from "../common";

import * as Specification from "../specification";
import * as Intrinsics from "../intrinsics";
import * as Library from "../library";

import { SyntaxTree, parseFile } from "./parser";
import {
  ModuleResolver,
  FunctionOverloadResolver,
  typeConversionAttempt
} from "./resolver";
import { ScopeStack } from "./scope";

export class Compiler {
  private _scope: ScopeStack;
  private _constants: Dictionary<Intrinsics.ConstantInfo>;
  private _statements: Specification.Statement[];
  private _moduleResolver: ModuleResolver;
  private _lastIndex: number;
  private _fieldTypeRegistry: { [name: string]: string };

  constructor() {
    this._scope = new ScopeStack();
    this._constants = new Dictionary<Intrinsics.ConstantInfo>();
    this._moduleResolver = new ModuleResolver();
    this._statements = [];
    this._lastIndex = 1;

    this.prepareFieldTypeRegistry();
    this.prepareConstants();
  }

  public prepareFieldTypeRegistry() {
    this._fieldTypeRegistry = {};
    const r = this._fieldTypeRegistry;
    for (const f of ["x", "y"]) {
      r[`Vector2.${f}`] = "float";
    }
    for (const f of ["x", "y", "z", "r", "g", "b"]) {
      r[`Vector3.${f}`] = "float";
    }
    for (const f of ["x", "y", "z", "w", "r", "g", "b", "a"]) {
      r[`Vector4.${f}`] = "float";
    }
    for (const f of ["r", "g", "b", "a"]) {
      r[`Color.${f}`] = "float";
    }
  }

  public prepareConstants() {
    Intrinsics.forEachConstant(info => {
      this._constants.set(info.name, info);
    });
  }

  public resolveFunction(
    name: string,
    args: Specification.Expression[],
    kwargs: { [name: string]: Specification.Expression }
  ): [SyntaxTree.FileBlockFunction, Specification.Expression[]] {
    const resolver = this._moduleResolver.getFunction(name);
    if (resolver) {
      return resolver.resolveArguments(args, kwargs);
    } else {
      throw new CompileError(`function '${name} is undefined.`);
    }
  }

  public loadFile(file: SyntaxTree.File) {
    for (const block of file.blocks) {
      if (block.type == "function") {
        const blockFunction = block as SyntaxTree.FileBlockFunction;
        this._moduleResolver.addFunction(blockFunction.name, blockFunction);
      }
      if (block.type == "import") {
        const blockImport = block as SyntaxTree.FileBlockImport;
        if (blockImport.functionNames != null) {
          blockImport.functionNames.forEach(name => {
            this._moduleResolver.importFunction(
              Library.getModule(blockImport.moduleName),
              name
            );
          });
        } else {
          const module = Library.getModule(blockImport.moduleName);
          module.forEach((func, name) => {
            this._moduleResolver.importFunction(module, name);
          });
        }
      }
    }
  }

  public getDefaultValueForType(type: string): number | number[] {
    if (type == "float") {
      return 0;
    }
    if (type == "Vector2") {
      return [0, 0];
    }
    if (type == "Vector3") {
      return [0, 0, 0];
    }
    if (type == "Vector4") {
      return [0, 0, 0, 0];
    }
    if (type == "Color") {
      return [0, 0, 0, 1];
    }
    if (type == "Quaternion") {
      return [0, 0, 0, 1];
    }
    return 0;
  }

  public compileFunctionToMark(
    globals: SyntaxTree.FileBlockGlobal[],
    block: SyntaxTree.FileBlockFunction
  ): Specification.Mark {
    // Re-init state.
    this._scope.resetScope();
    this._lastIndex = 1;

    const markInput: { [name: string]: Specification.Input } = {};
    const markOutput: { [name: string]: Specification.Output } = {};
    const markVariables: { [name: string]: string } = {};

    // Setup input parameters.
    for (const global of globals) {
      this._scope.addVariable(global.name, global.valueType, "global");
      markInput[global.name] = {
        type: global.valueType,
        default: global.default || this.getDefaultValueForType(global.valueType)
      };
    }
    for (const arg of block.arguments) {
      this._scope.addVariable(arg.name, arg.type, "local");
      markInput[arg.name] = {
        type: arg.type,
        default: arg.default || this.getDefaultValueForType(arg.type)
      };
    }

    // Flatten statements.
    this.compileStatements({
      type: "statements",
      statements: block.statements
    } as SyntaxTree.StatementStatements);

    // Figure out variables.
    this._scope.forEach((name: string, type: string) => {
      if (!markInput[name]) {
        markVariables[name] = type;
      }
    });

    // Figure out outputs.
    const processStatementsForOutputs = (
      statements: Specification.Statement[]
    ) => {
      statements.forEach(x => {
        if (x.type == "emit") {
          const sEmit = x as Specification.StatementEmit;
          for (const attr in sEmit.attributes) {
            if (markOutput.hasOwnProperty(attr)) {
              if (markOutput[attr].type != sEmit.attributes[attr].valueType) {
                throw new CompileError(
                  `output variable '${attr} has conflicting types.`
                );
              }
            } else {
              markOutput[attr] = { type: sEmit.attributes[attr].valueType };
            }
          }
        }
        if (x.type == "condition") {
          const sCondition = x as Specification.StatementCondition;
          processStatementsForOutputs(sCondition.trueStatements);
          processStatementsForOutputs(sCondition.falseStatements);
        }
        if (x.type == "for") {
          const sForLoop = x as Specification.StatementForLoop;
          processStatementsForOutputs(sForLoop.statements);
        }
      });
    };
    processStatementsForOutputs(this._statements);

    return {
      input: markInput,
      output: markOutput,
      variables: markVariables,
      statements: this._statements
    };
  }

  public addStatement(statement: Specification.Statement) {
    this._statements.push(statement);
  }

  public addStatements(statements: Specification.Statement[]) {
    this._statements = this._statements.concat(statements);
  }

  public captureStatements(callback: () => void): Specification.Statement[] {
    const currentStatements = this._statements;
    this._statements = [];
    callback();
    const result = this._statements;
    this._statements = currentStatements;
    return result;
  }

  public compileExpression(
    expression: SyntaxTree.Expression
  ): Specification.Expression {
    switch (expression.type) {
      case "value": {
        const expr = expression as SyntaxTree.ExpressionValue;
        return {
          type: "constant",
          value: expr.value,
          valueType: expr.valueType
        } as Specification.ExpressionConstant;
      }
      case "variable": {
        const expr = expression as SyntaxTree.ExpressionVariable;
        if (this._constants.has(expr.name)) {
          const cinfo = this._constants.get(expr.name);
          return {
            type: "constant",
            value: cinfo.value,
            valueType: cinfo.type
          } as Specification.ExpressionConstant;
        } else {
          return {
            type: "variable",
            variableName: this._scope.translateVariableName(expr.name),
            valueType: this._scope.getVariable(expr.name).type
          } as Specification.ExpressionVariable;
        }
      }
      case "field": {
        const expr = expression as SyntaxTree.ExpressionField;
        const valueExpr = this.compileExpression(expr.value);
        return {
          type: "field",
          fieldName: expr.fieldName,
          value: valueExpr,
          valueType: this._fieldTypeRegistry[
            valueExpr.valueType + "." + expr.fieldName
          ]
        } as Specification.ExpressionField;
      }
      case "function": {
        const expr = expression as SyntaxTree.ExpressionFunction;

        const args: Specification.Expression[] = [];
        const kwargs: { [name: string]: Specification.Expression } = {};

        for (const arg of expr.args.args) {
          args.push(this.compileExpression(arg));
        }
        for (const key in expr.args.kwargs) {
          const e = expr.args.kwargs[key];
          kwargs[key] = this.compileExpression(expr.args.kwargs[key]);
        }

        const [func, argExpressions] = this.resolveFunction(
          expr.name,
          args,
          kwargs
        );

        let returnValueExpression: Specification.Expression = null;

        if (!func.statements) {
          returnValueExpression = {
            type: "function",
            functionName: func.name,
            arguments: argExpressions,
            valueType: func.returnType
          } as Specification.ExpressionFunction;
        } else {
          const argMap = new Dictionary<string>();

          for (const argIndex in func.arguments) {
            const arg = func.arguments[argIndex];
            const mapped = this._scope.nextVariableName(arg.type);
            argMap.set(arg.name, mapped);
            this.addStatement({
              type: "assign",
              variableName: this._scope.translateVariableName(mapped),
              expression: argExpressions[argIndex]
            } as Specification.StatementAssign);
          }

          this._scope.pushScope(argMap);
          this._moduleResolver.enterFunctionImplementation(expr.name);
          for (const statement of func.statements) {
            if (statement.type == "return") {
              const statement_return = statement as SyntaxTree.StatementReturn;
              returnValueExpression = this.compileExpression(
                statement_return.value
              );
              break;
            } else {
              this.compileStatement(statement);
            }
          }
          this._moduleResolver.leaveFunctionImplementation(expr.name);
          this._scope.popScope();
        }
        return returnValueExpression;
      }
    }
    return null;
  }

  public compileStandaloneExpression(
    expression: SyntaxTree.Expression,
    variables: Dictionary<Specification.Expression>
  ): Specification.Expression {
    switch (expression.type) {
      case "value": {
        const expr = expression as SyntaxTree.ExpressionValue;
        return {
          type: "constant",
          value: expr.value,
          valueType: expr.valueType
        } as Specification.ExpressionConstant;
      }
      case "variable": {
        const expr = expression as SyntaxTree.ExpressionVariable;
        if (variables.has(expr.name)) {
          return variables.get(expr.name);
        } else {
          if (this._constants.has(expr.name)) {
            const cinfo = this._constants.get(expr.name);
            return {
              type: "constant",
              value: cinfo.value,
              valueType: cinfo.type
            } as Specification.ExpressionConstant;
          } else {
            throw new CompileError(`variable ${expr.name} is undefined`);
          }
        }
      }
      case "field": {
        const expr = expression as SyntaxTree.ExpressionField;
        const valueExpr = this.compileStandaloneExpression(
          expr.value,
          variables
        );
        return {
          type: "field",
          fieldName: expr.fieldName,
          value: valueExpr,
          valueType: this._fieldTypeRegistry[
            valueExpr.valueType + "." + expr.fieldName
          ]
        } as Specification.ExpressionField;
      }
      case "function": {
        const expr = expression as SyntaxTree.ExpressionFunction;

        const args: Specification.Expression[] = [];
        const kwargs: { [name: string]: Specification.Expression } = {};

        for (const arg of expr.args.args) {
          args.push(this.compileStandaloneExpression(arg, variables));
        }
        for (const key in expr.args.kwargs) {
          const e = expr.args.kwargs[key];
          kwargs[key] = this.compileStandaloneExpression(
            expr.args.kwargs[key],
            variables
          );
        }

        const [func, argExpressions] = this.resolveFunction(
          expr.name,
          args,
          kwargs
        );

        return {
          type: "function",
          functionName: func.name,
          arguments: argExpressions,
          valueType: func.returnType
        } as Specification.ExpressionFunction;
      }
    }
    return null;
  }

  public compileStatements(statements: SyntaxTree.StatementStatements): void {
    this._scope.pushScope();
    for (const s of statements.statements) {
      this.compileStatement(s);
    }
    this._scope.popScope();
  }

  public compileStatement(statement: SyntaxTree.Statement): void {
    switch (statement.type) {
      case "declare":
        {
          const s = statement as SyntaxTree.StatementDeclare;
          if (s.initial) {
            let ve = this.compileExpression(s.initial);
            let variableType = s.variableType;
            if (variableType == "auto") {
              variableType = ve.valueType;
            }
            this._scope.addVariable(s.variableName, variableType, "local");
            if (ve.valueType != variableType) {
              const veType = ve.valueType;
              ve = typeConversionAttempt(
                ve,
                this._scope.getVariable(s.variableName).type
              )[0];
              if (ve === null) {
                throw new CompileError(
                  `cannot convert type '${veType}' to '${variableType}'.`
                );
              }
            }
            this.addStatement({
              type: "assign",
              variableName: this._scope.translateVariableName(s.variableName),
              expression: ve
            } as Specification.StatementAssign);
          } else {
            this._scope.addVariable(s.variableName, s.variableType, "local");
          }
        }
        break;
      case "expression":
        {
          const s = statement as SyntaxTree.StatementExpression;
          this.compileExpression(s.expression);
        }
        break;
      case "assign":
        {
          const s = statement as SyntaxTree.StatementAssign;
          let ve = this.compileExpression(s.expression);
          const targetType = this._scope.getVariable(s.variableName).type;
          if (ve.valueType != targetType) {
            const veType = ve.valueType;
            ve = typeConversionAttempt(
              ve,
              this._scope.getVariable(s.variableName).type
            )[0];
            if (ve === null) {
              throw new CompileError(
                `cannot convert type '${veType} to '${targetType}'.`
              );
            }
          }
          this.addStatement({
            type: "assign",
            variableName: this._scope.translateVariableName(s.variableName),
            expression: ve
          } as Specification.StatementAssign);
        }
        break;
      case "emit":
        {
          const s = statement as SyntaxTree.StatementEmit;
          s.vertices.forEach(v => {
            const attrs: { [name: string]: Specification.Expression } = {};
            for (const argName in v) {
              const expr = v[argName];
              attrs[argName] = this.compileExpression(expr);
            }
            this.addStatement({
              type: "emit",
              attributes: attrs
            } as Specification.StatementEmit);
          });
        }
        break;
      case "discard":
        {
          this.addStatement({
            type: "discard"
          } as Specification.StatementDiscard);
        }
        break;
      case "statements":
        {
          const s = statement as SyntaxTree.StatementStatements;
          this.compileStatements(s);
        }
        break;
      case "for":
        {
          const s = statement as SyntaxTree.StatementForLoop;
          this._scope.pushScope();
          // Declare the loop variable
          this._scope.addVariable(s.variableName, "int", "local");
          const loopVariable = this._scope.translateVariableName(
            s.variableName
          );
          // Compile for statements
          const forStatement = {
            type: "for",
            variableName: loopVariable,
            rangeMin: s.start,
            rangeMax: s.end,
            statements: this.captureStatements(() =>
              this.compileStatement(s.statement)
            )
          } as Specification.StatementForLoop;
          this.addStatement(forStatement);
          this._scope.popScope();
        }
        break;
      case "if":
        {
          const s = statement as SyntaxTree.StatementIfStatement;
          // Function to compile the i-th condition in the if-elseif-else syntax.
          const compileIthCondition = (i: number) => {
            if (i < s.conditions.length) {
              const statements: Specification.Statement[] = [];
              this._scope.pushScope();
              const ve = this.compileExpression(s.conditions[i].condition);
              const cond: Specification.StatementCondition = {
                type: "condition",
                condition: ve,
                trueStatements: this.captureStatements(() =>
                  this.compileStatement(s.conditions[i].statement)
                ),
                falseStatements: this.captureStatements(() =>
                  compileIthCondition(i + 1)
                )
              };
              this.addStatement(cond);
              this._scope.popScope();
            } else {
              if (s.else) {
                this.compileStatement(s.else);
              }
            }
          };
          compileIthCondition(0);
        }
        break;
      case "return": {
        throw new CompileError("unexpected return statement");
      }
    }
  }
}

export function compileTree(file: SyntaxTree.File): Specification.Marks {
  const spec: Specification.Marks = {};
  const globals = file.blocks.filter(
    x => x.type == "global"
  ) as SyntaxTree.FileBlockGlobal[];
  for (const block of file.blocks) {
    if (block.type == "function") {
      const blockFunction = block as SyntaxTree.FileBlockFunction;
      if (blockFunction.isMark || blockFunction.isShader) {
        const scope = new Compiler();
        scope.loadFile(file);
        const mark = scope.compileFunctionToMark(globals, blockFunction);
        spec[blockFunction.name] = mark;
      }
    }
  }
  return spec;
}

const standaloneCompiler = new Compiler();
export function compileExpression(
  expr: SyntaxTree.Expression,
  variables: Dictionary<Specification.Expression>
): Specification.Expression {
  return standaloneCompiler.compileStandaloneExpression(expr, variables);
}

export function compileString(content: string): Specification.Marks {
  const file = parseFile(content);
  return compileTree(file);
}
