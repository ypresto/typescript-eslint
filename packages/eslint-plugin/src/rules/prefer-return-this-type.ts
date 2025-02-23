import {
  TSESTree,
  AST_NODE_TYPES,
} from '@typescript-eslint/experimental-utils';
import { createRule, forEachReturnStatement, getParserServices } from '../util';
import * as ts from 'typescript';

type ClassLikeDeclaration =
  | TSESTree.ClassDeclaration
  | TSESTree.ClassExpression;

type FunctionLike =
  | TSESTree.MethodDefinition['value']
  | TSESTree.ArrowFunctionExpression;

export default createRule({
  name: 'prefer-return-this-type',
  defaultOptions: [],

  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce that `this` is used when only `this` type is returned',
      category: 'Best Practices',
      recommended: false,
      requiresTypeChecking: true,
    },
    messages: {
      useThisType: 'use `this` type instead.',
    },
    schema: [],
    fixable: 'code',
  },

  create(context) {
    const parserServices = getParserServices(context);
    const checker = parserServices.program.getTypeChecker();

    function tryGetNameInType(
      name: string,
      typeNode: TSESTree.TypeNode,
    ): TSESTree.Identifier | undefined {
      if (
        typeNode.type === AST_NODE_TYPES.TSTypeReference &&
        typeNode.typeName.type === AST_NODE_TYPES.Identifier &&
        typeNode.typeName.name === name
      ) {
        return typeNode.typeName;
      }

      if (typeNode.type === AST_NODE_TYPES.TSUnionType) {
        for (const type of typeNode.types) {
          const found = tryGetNameInType(name, type);
          if (found) {
            return found;
          }
        }
      }

      return undefined;
    }

    function isThisSpecifiedInParameters(originalFunc: FunctionLike): boolean {
      const firstArg = originalFunc.params[0];
      return (
        firstArg &&
        firstArg.type === AST_NODE_TYPES.Identifier &&
        firstArg.name === 'this'
      );
    }

    function isFunctionReturningThis(
      originalFunc: FunctionLike,
      originalClass: ClassLikeDeclaration,
    ): boolean {
      if (isThisSpecifiedInParameters(originalFunc)) {
        return false;
      }

      const func = parserServices.esTreeNodeToTSNodeMap.get(originalFunc);

      if (!func.body) {
        return false;
      }

      const classType = checker.getTypeAtLocation(
        parserServices.esTreeNodeToTSNodeMap.get(originalClass),
      ) as ts.InterfaceType;

      if (func.body.kind !== ts.SyntaxKind.Block) {
        const type = checker.getTypeAtLocation(func.body);
        return classType.thisType === type;
      }

      let hasReturnThis = false;
      let hasReturnClassType = false;

      forEachReturnStatement(func.body as ts.Block, stmt => {
        const expr = stmt.expression;
        if (!expr) {
          return;
        }

        // fast check
        if (expr.kind === ts.SyntaxKind.ThisKeyword) {
          hasReturnThis = true;
          return;
        }

        const type = checker.getTypeAtLocation(expr);
        if (classType === type) {
          hasReturnClassType = true;
          return true;
        }

        if (classType.thisType === type) {
          hasReturnThis = true;
          return;
        }

        return;
      });

      return !hasReturnClassType && hasReturnThis;
    }

    function checkFunction(
      originalFunc: FunctionLike,
      originalClass: ClassLikeDeclaration,
    ): void {
      const className = originalClass.id?.name;
      if (!className) {
        return;
      }

      if (!originalFunc.returnType) {
        return;
      }

      const classNameRef = tryGetNameInType(
        className,
        originalFunc.returnType.typeAnnotation,
      );
      if (!classNameRef) {
        return;
      }

      if (isFunctionReturningThis(originalFunc, originalClass)) {
        context.report({
          node: classNameRef,
          messageId: 'useThisType',
          fix(fixer) {
            return fixer.replaceText(classNameRef, 'this');
          },
        });
      }
    }

    return {
      'ClassBody > MethodDefinition'(node: TSESTree.MethodDefinition): void {
        checkFunction(node.value, node.parent!.parent as ClassLikeDeclaration);
      },
      'ClassBody > ClassProperty'(node: TSESTree.ClassProperty): void {
        if (
          !(
            node.value?.type === AST_NODE_TYPES.FunctionExpression ||
            node.value?.type === AST_NODE_TYPES.ArrowFunctionExpression
          )
        ) {
          return;
        }

        checkFunction(node.value, node.parent!.parent as ClassLikeDeclaration);
      },
    };
  },
});
