/*
* typeAnalyzer.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* A parse tree walker that performs static type checking. It assumes
* that the binder has already run and added information to
* the parse nodes.
*/

import * as assert from 'assert';

import { DiagnosticLevel } from '../common/configOptions';
import { AddMissingOptionalToParamAction, DiagnosticAddendum } from '../common/diagnostic';
import { DiagnosticRule } from '../common/diagnosticRules';
import { TextRange } from '../common/textRange';
import { AssertNode, AssignmentExpressionNode, AssignmentNode, AugmentedAssignmentNode,
    BinaryOperationNode, CallNode, ClassNode, DecoratorNode,
    DelNode, ErrorNode, ExceptNode, ExpressionNode, FormatStringNode, ForNode,
    FunctionNode, IfNode, ImportAsNode, ImportFromNode, IndexNode, LambdaNode,
    ListComprehensionNode, MemberAccessNode, ModuleNode, NameNode, ParameterCategory,
    ParameterNode, ParseNode, ParseNodeType, RaiseNode, ReturnNode, SliceNode,
    StringListNode, SuiteNode, TernaryNode, TupleNode,
    TypeAnnotationNode, UnaryOperationNode, UnpackNode, WhileNode,
    WithNode, YieldFromNode, YieldNode } from '../parser/parseNodes';
import { KeywordType } from '../parser/tokenizerTypes';
import { AnalyzerFileInfo } from './analyzerFileInfo';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { FlowFlags } from './codeFlow';
import { Declaration, DeclarationType } from './declaration';
import * as DeclarationUtils from './declarationUtils';
import { createExpressionEvaluator, EvaluatorFlags, ExpressionEvaluator,
    MemberAccessFlags } from './expressionEvaluator';
import * as ParseTreeUtils from './parseTreeUtils';
import { ParseTreeWalker } from './parseTreeWalker';
import { Scope, ScopeType } from './scope';
import * as ScopeUtils from './scopeUtils';
import { Symbol } from './symbol';
import * as SymbolNameUtils from './symbolNameUtils';
import { getEffectiveTypeOfSymbol, getLastTypedDeclaredForSymbol } from './symbolUtils';
import { ClassType, combineTypes, FunctionType, isAnyOrUnknown, isNoneOrNever,
    isTypeSame, ModuleType, NoneType, ObjectType, OverloadedFunctionEntry,
    OverloadedFunctionType, printType, PropertyType, removeNoneFromUnion,
    Type, TypeCategory, UnknownType  } from './types';
import * as TypeUtils from './typeUtils';

// At some point, we'll cut off the analysis passes and assume
// we're making no forward progress. This should happen only
// on the case of bugs in the analyzer.
// The number is somewhat arbitrary. It needs to be at least
// 21 or so to handle all of the import cycles in the stdlib
// files.
const _maxAnalysisPassCount = 50;

export class TypeAnalyzer extends ParseTreeWalker {
    private readonly _moduleNode: ModuleNode;
    private readonly _fileInfo: AnalyzerFileInfo;
    private readonly _evaluator: ExpressionEvaluator;
    private _currentScope: Scope;

    // Indicates where there was a change in the type analysis
    // the last time analyze() was called. Callers should repeatedly
    // call analyze() until this returns false.
    private _didAnalysisChange: boolean;

    // The last reason the analysis needed to change. Useful for
    // determining how to reduce the number of analysis passes.
    private _lastAnalysisChangeReason: string;

    // A list of all nodes that are defined within the module that
    // have their own scopes.
    private _scopedNodes: AnalyzerNodeInfo.ScopedNode[] = [];

    // Analysis version is incremented each time an analyzer pass
    // is performed. It allows the code to determine when cached
    // type information needs to be regenerated because it was
    // from a previous pass.
    private _analysisVersion = 0;

    // Map of symbols that have been accessed within this module.
    // Used to report unaccessed symbols.
    private _accessedSymbolMap: Map<number, true>;

    constructor(node: ModuleNode, accessedSymbolMap: Map<number, true>, analysisVersion: number) {
        super();

        this._moduleNode = node;
        this._fileInfo = AnalyzerNodeInfo.getFileInfo(node)!;
        this._currentScope = AnalyzerNodeInfo.getScope(node)!;
        this._didAnalysisChange = false;
        this._accessedSymbolMap = accessedSymbolMap;
        this._analysisVersion = analysisVersion;
        this._evaluator = createExpressionEvaluator(
            this._fileInfo.diagnosticSink,
            this._analysisVersion,
            reason => {
                this._setAnalysisChanged(reason);
            },
            this._accessedSymbolMap,
            this._fileInfo.importLookup);
    }

    analyze() {
        this._didAnalysisChange = false;
        this._scopedNodes.push(this._moduleNode);

        this.walkMultiple(this._moduleNode.statements);

        let requiresAnotherPass = this._didAnalysisChange;

        // If we've already analyzed the file the max number of times,
        // just give up and admit defeat. This should happen only in
        // the case of analyzer bugs.
        if (this.isAtMaxAnalysisPassCount()) {
            requiresAnotherPass = false;
        }

        if (!requiresAnotherPass) {
            // Perform a one-time validation of symbols in all scopes
            // defined in this module for things like unaccessed variables.
            this._validateSymbolTables();
        }

        return requiresAnotherPass;
    }

    walk(node: ParseNode) {
        if (!this._isCodeUnreachable(node)) {
            super.walk(node);
        }
    }

    isAtMaxAnalysisPassCount() {
        return this._analysisVersion >= _maxAnalysisPassCount;
    }

    getLastReanalysisReason() {
        return this._lastAnalysisChangeReason;
    }

    visitClass(node: ClassNode): boolean {
        const classTypeResult = this._evaluator.getTypeOfClass(node);

        this._enterScope(node, () => {
            this.walk(node.suite);
        });

        this.walkMultiple(node.decorators);
        this.walkMultiple(node.arguments);

        this._validateClassMethods(classTypeResult.classType);
        if (ClassType.isTypedDictClass(classTypeResult.classType)) {
            this._validateTypedDictClassSuite(node.suite);
        }

        return false;
    }

    visitFunction(node: FunctionNode): boolean {
        // Retrieve the containing class node if the function is a method.
        const containingClassNode = ParseTreeUtils.getEnclosingClass(node, true);
        const containingClassType = containingClassNode ?
            AnalyzerNodeInfo.getExpressionType(containingClassNode) as ClassType : undefined;

        const functionType = AnalyzerNodeInfo.getExpressionType(node) as FunctionType;
        assert(functionType.category === TypeCategory.Function);

        if (this._fileInfo.isBuiltInStubFile || this._fileInfo.isTypingStubFile) {
            // Stash away the name of the function since we need to handle
            // 'namedtuple', 'abstractmethod', 'dataclass' and 'NewType'
            // specially.
            FunctionType.setBuiltInName(functionType, node.name.nameToken.value);
        }

        let asyncType = functionType;
        if (node.isAsync) {
            asyncType = this._createAwaitableFunction(node, functionType);
        }

        // Apply all of the decorators in reverse order.
        let decoratedType: Type = asyncType;
        let foundUnknown = false;
        for (let i = node.decorators.length - 1; i >= 0; i--) {
            const decorator = node.decorators[i];

            decoratedType = this._applyFunctionDecorator(decoratedType, functionType, decorator);
            if (decoratedType.category === TypeCategory.Unknown) {
                // Report this error only on the first unknown type.
                if (!foundUnknown) {
                    this._evaluator.addDiagnostic(
                        this._fileInfo.diagnosticSettings.reportUntypedFunctionDecorator,
                        DiagnosticRule.reportUntypedFunctionDecorator,
                        `Untyped function declarator obscures type of function`,
                        node.decorators[i].leftExpression);

                    foundUnknown = true;
                }
            }
        }

        // Mark the class as abstract if it contains at least one abstract method.
        if (FunctionType.isAbstractMethod(functionType) && containingClassType) {
            ClassType.setIsAbstractClass(containingClassType);
        }

        if (containingClassNode) {
            if (!FunctionType.isClassMethod(functionType) && !FunctionType.isStaticMethod(functionType)) {
                // Mark the function as an instance method.
                FunctionType.setIsInstanceMethod(functionType);

                // If there's a separate async version, mark it as an instance
                // method as well.
                if (functionType !== asyncType) {
                    FunctionType.setIsInstanceMethod(asyncType);
                }
            }
        }

        node.parameters.forEach((param: ParameterNode, index) => {
            let annotatedType: Type | undefined;
            let concreteAnnotatedType: Type | undefined;
            let defaultValueType: Type | undefined;
            let isNoneWithoutOptional = false;

            if (param.typeAnnotation) {
                annotatedType = this._evaluator.getTypeOfAnnotation(param.typeAnnotation);

                // PEP 484 indicates that if a parameter has a default value of 'None'
                // the type checker should assume that the type is optional (i.e. a union
                // of the specified type and 'None').
                if (param.defaultValue && param.defaultValue.nodeType === ParseNodeType.Constant) {
                    if (param.defaultValue.token.keywordType === KeywordType.None) {
                        isNoneWithoutOptional = true;

                        if (!this._fileInfo.diagnosticSettings.strictParameterNoneValue) {
                            annotatedType = combineTypes(
                                [annotatedType, NoneType.create()]);
                        }
                    }
                }

                concreteAnnotatedType = TypeUtils.specializeType(annotatedType, undefined);
            }

            if (param.defaultValue) {
                defaultValueType = this._getTypeOfExpression(param.defaultValue,
                    EvaluatorFlags.ConvertEllipsisToAny, annotatedType);

                this.walk(param.defaultValue);
            }

            if (param.typeAnnotation && annotatedType) {
                // If there was both a type annotation and a default value, verify
                // that the default value matches the annotation.
                if (param.defaultValue && defaultValueType && concreteAnnotatedType) {
                    const diagAddendum = new DiagnosticAddendum();

                    if (!TypeUtils.canAssignType(concreteAnnotatedType, defaultValueType,
                            diagAddendum, this._fileInfo.importLookup)) {

                        const diag = this._evaluator.addError(
                            `Value of type '${ printType(defaultValueType) }' cannot` +
                                ` be assigned to parameter of type '${ printType(annotatedType) }'` +
                                diagAddendum.getString(),
                            param.defaultValue);

                        if (isNoneWithoutOptional) {
                            const addOptionalAction: AddMissingOptionalToParamAction = {
                                action: 'pyright.addoptionalforparam',
                                offsetOfTypeNode: param.typeAnnotation.start + 1
                            };
                            if (diag) {
                                diag.addAction(addOptionalAction);
                            }
                        }
                    }
                }

                if (FunctionType.setParameterType(functionType, index, annotatedType)) {
                    this._setAnalysisChanged('Function parameter type annotation changed');
                }

                this.walk(param.typeAnnotation);
            } else if (index === 0 && (
                    FunctionType.isInstanceMethod(functionType) ||
                    FunctionType.isClassMethod(functionType) ||
                    FunctionType.isConstructorMethod(functionType))) {

                // Specify type of "self" or "cls" parameter for instance or class methods
                // if the type is not explicitly provided.
                if (containingClassType) {
                    const paramType = FunctionType.getParameters(functionType)[0].type;

                    if (paramType.category === TypeCategory.Unknown) {
                        // Don't specialize the "self" for protocol classes because type
                        // comparisons will fail during structural typing analysis.
                        if (containingClassType && !ClassType.isProtocol(containingClassType)) {
                            if (FunctionType.isInstanceMethod(functionType)) {
                                const specializedClassType = TypeUtils.selfSpecializeClassType(containingClassType);
                                if (FunctionType.setParameterType(functionType, index, ObjectType.create(specializedClassType))) {
                                    this._setAnalysisChanged('Specialized self changed');
                                }
                            } else if (FunctionType.isClassMethod(functionType) ||
                                    FunctionType.isConstructorMethod(functionType)) {

                                // For class methods, the cls parameter is allowed to skip the
                                // abstract class test because the caller is possibly passing
                                // in a non-abstract subclass.
                                const specializedClassType = TypeUtils.selfSpecializeClassType(
                                    containingClassType, true);
                                if (FunctionType.setParameterType(functionType, index, specializedClassType)) {
                                    this._setAnalysisChanged('Specialized cls changed');
                                }
                            }
                        }
                    }
                }
            } else {
                // There is no annotation, and we can't infer the type.
                if (param.name) {
                    this._evaluator.addDiagnostic(
                        this._fileInfo.diagnosticSettings.reportUnknownParameterType,
                        DiagnosticRule.reportUnknownParameterType,
                        `Type of '${ param.name.nameToken.value }' is unknown`,
                        param.name);
                }
            }
        });

        // If there was a defined return type, analyze that first so when we
        // walk the contents of the function, return statements can be
        // validated against this type.
        if (node.returnTypeAnnotation) {
            const returnType = this._evaluator.getTypeOfAnnotation(node.returnTypeAnnotation);
            if (FunctionType.setDeclaredReturnType(functionType, returnType)) {
                this._setAnalysisChanged('Function return type annotation changed');
            }

            this.walk(node.returnTypeAnnotation);
        }

        this._enterScope(node, () => {
            const parameters = FunctionType.getParameters(functionType);
            assert(parameters.length === node.parameters.length);

            // Add the parameters to the scope and bind their types.
            parameters.forEach((param, index) => {
                const paramNode = node.parameters[index];
                if (paramNode.name) {
                    const specializedParamType = TypeUtils.specializeType(param.type, undefined);

                    assert(paramNode !== undefined && paramNode.name !== undefined);

                    // If the type contains type variables, specialize them now
                    // so we convert them to a concrete type (or unknown if there
                    // is no bound or constraint).
                    const variadicParamType = this._getVariadicParamType(param.category, specializedParamType);
                    this._evaluator.updateExpressionTypeForNode(paramNode.name, variadicParamType);

                    // Cache the type for the hover provider. Don't walk
                    // the default value because it needs to be evaluated
                    // outside of this scope.
                    this.walk(paramNode.name);
                }
            });

            this.walk(node.suite);

            // Validate that the function returns the declared type.
            this._validateFunctionReturn(node, functionType);
        });

        // If there was no decorator, see if there are any overloads provided
        // by previous function declarations.
        if (decoratedType === functionType) {
            const overloadedType = this._addOverloadsToFunctionType(node, decoratedType);
            this._evaluator.assignTypeToNameNode(node.name, overloadedType);
        } else {
            this._evaluator.assignTypeToNameNode(node.name, decoratedType);
        }

        if (containingClassNode) {
            this._validateMethod(node, functionType);
        }

        this.walkMultiple(node.decorators);

        return false;
    }

    visitLambda(node: LambdaNode): boolean {
        this._getTypeOfExpression(node);

        this._enterScope(node, () => {
            // Walk the children.
            this.walkMultiple([...node.parameters, node.expression]);

            node.parameters.forEach(param => {
                if (param.name) {
                    const paramType = this._getTypeOfExpression(param.name);
                    if (paramType.category === TypeCategory.Unknown) {
                        this._evaluator.addDiagnostic(
                            this._fileInfo.diagnosticSettings.reportUnknownLambdaType,
                            DiagnosticRule.reportUnknownLambdaType,
                            `Type of '${ param.name.nameToken.value }' is unknown`,
                            param.name);
                    } else if (TypeUtils.containsUnknown(paramType)) {
                        this._evaluator.addDiagnostic(
                            this._fileInfo.diagnosticSettings.reportUnknownLambdaType,
                            DiagnosticRule.reportUnknownLambdaType,
                            `Type of '${ param.name.nameToken.value }', ` +
                            `'${ printType(paramType) }', is partially unknown`,
                            param.name);
                    }
                }
            });

            const returnType = this._getTypeOfExpression(node.expression);
            if (returnType.category === TypeCategory.Unknown) {
                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportUnknownLambdaType,
                    DiagnosticRule.reportUnknownLambdaType,
                    `Type of lambda expression is unknown`, node.expression);
            } else if (TypeUtils.containsUnknown(returnType)) {
                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportUnknownLambdaType,
                    DiagnosticRule.reportUnknownLambdaType,
                    `Type of lambda expression, '${ printType(returnType) }', is partially unknown`,
                    node.expression);
            }
        });

        return false;
    }

    visitCall(node: CallNode): boolean {
        this._getTypeOfExpression(node);

        this._validateIsInstanceCallNecessary(node);

        if (ParseTreeUtils.isWithinDefaultParamInitializer(node) && !this._fileInfo.isStubFile) {
            this._evaluator.addDiagnostic(
                this._fileInfo.diagnosticSettings.reportCallInDefaultInitializer,
                DiagnosticRule.reportCallInDefaultInitializer,
                `Function calls within default value initializer are not permitted`,
                node);
        }

        return true;
    }

    visitFor(node: ForNode): boolean {
        const iteratorType = this._getTypeOfExpression(node.iterableExpression);
        const iteratedType = this._evaluator.getTypeFromIterable(
            iteratorType, !!node.isAsync, node.iterableExpression, !node.isAsync);

        this._evaluator.assignTypeToExpression(node.targetExpression, iteratedType, node.targetExpression);
        return true;
    }

    visitListComprehension(node: ListComprehensionNode): boolean {
        this._getTypeOfExpression(node);
        return true;
    }

    visitIf(node: IfNode): boolean {
        this._getTypeOfExpression(node.testExpression);
        return true;
    }

    visitWhile(node: WhileNode): boolean {
        this._getTypeOfExpression(node.testExpression);
        return true;
    }

    visitWith(node: WithNode): boolean {
        node.withItems.forEach(item => {
            let exprType = this._getTypeOfExpression(item.expression);

            if (TypeUtils.isOptionalType(exprType)) {
                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportOptionalContextManager,
                    DiagnosticRule.reportOptionalContextManager,
                    `Object of type 'None' cannot be used with 'with'`,
                    item.expression);
                exprType = removeNoneFromUnion(exprType);
            }

            const enterMethodName = node.isAsync ? '__aenter__' : '__enter__';

            const scopedType = TypeUtils.doForSubtypes(exprType, subtype => {
                if (isAnyOrUnknown(subtype)) {
                    return subtype;
                }

                if (subtype.category === TypeCategory.Object) {
                    const memberType = this._evaluator.getTypeFromObjectMember(item.expression,
                        subtype, enterMethodName, { method: 'get' }, MemberAccessFlags.None);

                    if (memberType) {
                        let memberReturnType: Type;
                        if (memberType.category === TypeCategory.Function) {
                            memberReturnType = FunctionType.getEffectiveReturnType(memberType);
                        } else {
                            memberReturnType = UnknownType.create();
                        }

                        // For "async while", an implicit "await" is performed.
                        if (node.isAsync) {
                            memberReturnType = this._evaluator.getTypeFromAwaitable(
                                memberReturnType, item);
                        }

                        return memberReturnType;
                    }
                }

                this._evaluator.addError(`Type ${ printType(subtype) } cannot be used ` +
                    `with 'with' because it does not implement '${ enterMethodName }'`,
                    item.expression);
                return UnknownType.create();
            });

            if (item.target) {
                this._evaluator.assignTypeToExpression(item.target, scopedType, item.target);
            }
        });

        return true;
    }

    visitReturn(node: ReturnNode): boolean {
        let returnType: Type;

        const enclosingFunctionNode = ParseTreeUtils.getEnclosingFunction(node);
        const declaredReturnType = enclosingFunctionNode ?
            DeclarationUtils.getFunctionDeclaredReturnType(enclosingFunctionNode) :
            undefined;

        if (node.returnExpression) {
            returnType = this._getTypeOfExpression(node.returnExpression,
                EvaluatorFlags.None, declaredReturnType);
        } else {
            // There is no return expression, so "None" is assumed.
            returnType = NoneType.create();
        }

        if (this._isNodeReachable(node) && enclosingFunctionNode) {
            if (declaredReturnType) {
                if (TypeUtils.isNoReturnType(declaredReturnType)) {
                    this._evaluator.addError(
                        `Function with declared return type 'NoReturn' cannot include a return statement`,
                        node);
                } else {
                    const diagAddendum = new DiagnosticAddendum();

                    // Specialize the return type in case it contains references to type variables.
                    // These will be replaced with the corresponding constraint or bound types.
                    const specializedDeclaredType = TypeUtils.specializeType(declaredReturnType, undefined);
                    if (!TypeUtils.canAssignType(specializedDeclaredType, returnType,
                            diagAddendum, this._fileInfo.importLookup)) {

                        this._evaluator.addError(
                            `Expression of type '${ printType(returnType) }' cannot be assigned ` +
                                `to return type '${ printType(specializedDeclaredType) }'` +
                                diagAddendum.getString(),
                            node.returnExpression ? node.returnExpression : node);
                    }
                }
            }
        }

        return true;
    }

    visitYield(node: YieldNode) {
        const yieldType = node.expression ?
            this._getTypeOfExpression(node.expression) : NoneType.create();

        // Wrap the yield type in an Iterator.
        let adjYieldType = yieldType;
        const iteratorType = ScopeUtils.getBuiltInType(this._currentScope, 'Iterator',
            this._fileInfo.importLookup);
        if (iteratorType.category === TypeCategory.Class) {
            adjYieldType = ObjectType.create(ClassType.cloneForSpecialization(iteratorType, [yieldType]));
        } else {
            adjYieldType = UnknownType.create();
        }

        this._validateYieldType(node, adjYieldType);

        return true;
    }

    visitYieldFrom(node: YieldFromNode) {
        const yieldType = this._getTypeOfExpression(node.expression);
        this._validateYieldType(node, yieldType);

        return true;
    }

    visitRaise(node: RaiseNode): boolean {
        const baseExceptionType = ScopeUtils.getBuiltInType(
            this._currentScope, 'BaseException', this._fileInfo.importLookup) as ClassType;

        if (node.typeExpression) {
            const exceptionType = this._getTypeOfExpression(node.typeExpression);

            // Validate that the argument of "raise" is an exception object or class.
            if (baseExceptionType && baseExceptionType.category === TypeCategory.Class) {
                const diagAddendum = new DiagnosticAddendum();

                TypeUtils.doForSubtypes(exceptionType, subtype => {
                    if (!isAnyOrUnknown(subtype)) {
                        if (subtype.category === TypeCategory.Class) {
                            if (!TypeUtils.derivesFromClassRecursive(subtype, baseExceptionType)) {
                                diagAddendum.addMessage(`'${ printType(subtype) }' does not derive from BaseException`);
                            }
                        } else if (subtype.category === TypeCategory.Object) {
                            if (!TypeUtils.derivesFromClassRecursive(subtype.classType, baseExceptionType)) {
                                diagAddendum.addMessage(`'${ printType(subtype) }' does not derive from BaseException`);
                            }
                        } else {
                            diagAddendum.addMessage(`'${ printType(subtype) }' does not derive from BaseException`);
                        }
                    }

                    return subtype;
                });

                if (diagAddendum.getMessageCount() > 0) {
                    this._evaluator.addError(`Expected exception class or object` + diagAddendum.getString(), node.typeExpression);
                }
            }
        }

        if (node.valueExpression) {
            const exceptionType = this._getTypeOfExpression(node.valueExpression);

            // Validate that the argument of "raise" is an exception object or None.
            if (baseExceptionType && baseExceptionType.category === TypeCategory.Class) {
                const diagAddendum = new DiagnosticAddendum();

                TypeUtils.doForSubtypes(exceptionType, subtype => {
                    if (!isAnyOrUnknown(subtype) && !isNoneOrNever(subtype)) {
                        if (subtype.category === TypeCategory.Object) {
                            if (!TypeUtils.derivesFromClassRecursive(subtype.classType, baseExceptionType)) {
                                diagAddendum.addMessage(`'${ printType(subtype) }' does not derive from BaseException`);
                            }
                        } else {
                            diagAddendum.addMessage(`'${ printType(subtype) }' does not derive from BaseException`);
                        }
                    }

                    return subtype;
                });

                if (diagAddendum.getMessageCount() > 0) {
                    this._evaluator.addError(`Expected exception object or None` + diagAddendum.getString(), node.valueExpression);
                }
            }
        }

        return true;
    }

    visitExcept(node: ExceptNode): boolean {
        let exceptionType: Type;
        if (node.typeExpression) {
            exceptionType = this._getTypeOfExpression(node.typeExpression);

            if (node.name) {
                exceptionType = TypeUtils.doForSubtypes(exceptionType, subType => {
                    // If more than one type was specified for the exception, we'll receive
                    // a specialized tuple object here.
                    const tupleType = TypeUtils.getSpecializedTupleType(subType);
                    if (tupleType && ClassType.getTypeArguments(tupleType)) {
                        const entryTypes = ClassType.getTypeArguments(tupleType)!.map(t => {
                            return this._validateExceptionType(t, node.typeExpression!);
                        });
                        return combineTypes(entryTypes);
                    }

                    return this._validateExceptionType(subType, node.typeExpression!);
                });

                this._evaluator.updateExpressionTypeForNode(node.name, exceptionType);
            }
        }

        return true;
    }

    visitAssert(node: AssertNode) {
        if (node.exceptionExpression) {
            this._getTypeOfExpression(node.exceptionExpression);
        }

        this._getTypeOfExpression(node.testExpression);
        return true;
    }

    visitAssignment(node: AssignmentNode): boolean {
        this._evaluator.getTypeOfAssignmentStatementTarget(node);
        if (node.typeAnnotationComment) {
            // Evaluate the annotated type.
            const declaredType = this._evaluator.getTypeOfAnnotation(node.typeAnnotationComment);
            this._validateDeclaredTypeMatches(node.leftExpression, declaredType,
                node.typeAnnotationComment);
        }

        return true;
    }

    visitAssignmentExpression(node: AssignmentExpressionNode): boolean {
        this._getTypeOfExpression(node);
        return true;
    }

    visitAugmentedAssignment(node: AugmentedAssignmentNode): boolean {
        this._evaluator.getTypeOfAugmentedAssignmentTarget(node);
        return true;
    }

    visitIndex(node: IndexNode): boolean {
        this._getTypeOfExpression(node);
        return true;
    }

    visitBinaryOperation(node: BinaryOperationNode): boolean {
        this._getTypeOfExpression(node);
        return true;
    }

    visitSlice(node: SliceNode): boolean {
        this._getTypeOfExpression(node);
        return true;
    }

    visitUnpack(node: UnpackNode): boolean {
        this._getTypeOfExpression(node);
        return true;
    }

    visitTuple(node: TupleNode): boolean {
        this._getTypeOfExpression(node);
        return true;
    }

    visitUnaryOperation(node: UnaryOperationNode): boolean {
        this._getTypeOfExpression(node);
        return true;
    }

    visitTernary(node: TernaryNode): boolean {
        this._getTypeOfExpression(node);
        return true;
    }

    visitStringList(node: StringListNode): boolean {
        if (node.typeAnnotation) {
            // Should we ignore this type annotation?
            if (this._evaluator.isAnnotationLiteralValue(node)) {
                return false;
            }

            this._getTypeOfExpression(node.typeAnnotation,
                EvaluatorFlags.AllowForwardReferences);
        }

        return true;
    }

    visitFormatString(node: FormatStringNode): boolean {
        node.expressions.forEach(formatExpr => {
            this._getTypeOfExpression(formatExpr);
        });

        return true;
    }

    visitName(node: NameNode) {
        // Determine if we should log information about private usage.
        this._conditionallyReportPrivateUsage(node);
        return true;
    }

    visitDel(node: DelNode) {
        node.expressions.forEach(expr => {
            this._evaluateExpressionForDeletion(expr);

            if (expr.nodeType === ParseNodeType.Name) {
                const symbolWithScope = this._currentScope.lookUpSymbolRecursive(expr.nameToken.value);
                if (symbolWithScope) {
                    const decl = getLastTypedDeclaredForSymbol(symbolWithScope.symbol);
                    if (decl) {
                        if (decl.type === DeclarationType.Function || decl.type === DeclarationType.Method) {
                            this._evaluator.addError('Del should not be applied to function', expr);
                        } else if (decl.type === DeclarationType.Class) {
                            this._evaluator.addError('Del should not be applied to class', expr);
                        }
                    }
                }
            }
        });

        return true;
    }

    visitMemberAccess(node: MemberAccessNode) {
        this._getTypeOfExpression(node);
        this._conditionallyReportPrivateUsage(node.memberName);

        // Walk the leftExpression but not the memberName.
        this.walk(node.leftExpression);

        return false;
    }

    visitImportAs(node: ImportAsNode): boolean {
        if (node.module.nameParts.length === 0) {
            return false;
        }

        let symbolNameNode: NameNode;
        if (node.alias) {
            // The symbol name is defined by the alias.
            symbolNameNode = node.alias;
        } else {
            // There was no alias, so we need to use the first element of
            // the name parts as the symbol.
            symbolNameNode = node.module.nameParts[0];
        }

        // Look up the symbol to find the alias declaration.
        let symbolType = this._getAliasedSymbolTypeForName(symbolNameNode.nameToken.value) ||
            UnknownType.create();

        // Is there a cached module type associated with this node? If so, use
        // it instead of the type we just created. This will preserve the
        // symbol accessed flags.
        const cachedModuleType = AnalyzerNodeInfo.getExpressionType(node) as ModuleType;
        if (cachedModuleType && cachedModuleType.category === TypeCategory.Module && symbolType) {
            if (isTypeSame(symbolType, cachedModuleType)) {
                symbolType = cachedModuleType;
            }
        }

        // Cache the module type for subsequent passes.
        AnalyzerNodeInfo.setExpressionType(node, symbolType);

        this._evaluator.assignTypeToNameNode(symbolNameNode, symbolType);

        return false;
    }

    visitImportFrom(node: ImportFromNode): boolean {
        const importInfo = AnalyzerNodeInfo.getImportInfo(node.module);

        if (importInfo && importInfo.isImportFound) {
            if (!node.isWildcardImport) {
                const resolvedPath = importInfo.resolvedPaths[importInfo.resolvedPaths.length - 1];
                const lookupInfo = this._fileInfo.importLookup(resolvedPath);
                node.imports.forEach(importAs => {
                    const aliasNode = importAs.alias || importAs.name;
                    let symbolType = this._getAliasedSymbolTypeForName(aliasNode.nameToken.value);
                    if (!symbolType) {
                        // If we were able to resolve the import, report the error as
                        // an unresolvable symbol.
                        if (lookupInfo) {
                            this._evaluator.addError(
                                `'${ importAs.name.nameToken.value }' is unknown import symbol`,
                                importAs.name
                            );
                        }
                        symbolType = UnknownType.create();
                    }

                    this._evaluator.assignTypeToNameNode(aliasNode, symbolType);
                });
            }
        }

        return false;
    }

    visitTypeAnnotation(node: TypeAnnotationNode): boolean {
        // Evaluate the annotated type.
        let declaredType = this._evaluator.getTypeOfAnnotation(node.typeAnnotation);

        // If this is within an enum, transform the type.
        if (node.valueExpression && node.valueExpression.nodeType === ParseNodeType.Name) {
            declaredType = this._evaluator.transformTypeForPossibleEnumClass(
                node.valueExpression, declaredType);
        }

        // If this annotation isn't part of an assignment operation,
        // update the type on the name node for the hover provider.
        // If it's part of an assignment operation, the assignment
        // operation will set the type.
        if (node.parent && node.parent.nodeType !== ParseNodeType.Assignment) {
            this._evaluator.updateExpressionTypeForNode(node.valueExpression, declaredType);
        }

        this._validateDeclaredTypeMatches(node.valueExpression, declaredType,
            node.typeAnnotation);

        return true;
    }

    visitError(node: ErrorNode) {
        // Get the type of the child so it's available to
        // the completion provider.
        if (node.child) {
            this._getTypeOfExpression(node.child);
        }

        // Don't explore further.
        return false;
    }

    private _validateSymbolTables() {
        // Never report symbol table issues in stub files.
        if (this._fileInfo.isStubFile) {
            return;
        }

        for (const scopedNode of this._scopedNodes) {
            const scope = AnalyzerNodeInfo.getScope(scopedNode)!;
            const symbolTable = scope.getSymbolTable();
            const scopeType = scope.getType();

            symbolTable.forEach((symbol, name) => {
                this._conditionallyReportUnusedSymbol(name, symbol, scopeType);
            });
        }
    }

    private _conditionallyReportUnusedSymbol(name: string, symbol: Symbol, scopeType: ScopeType) {
        if (symbol.isIgnoredForProtocolMatch() || this._accessedSymbolMap.has(symbol.getId())) {
            return;
        }

        // A name of "_" means "I know this symbol isn't used", so
        // don't report it as unused.
        if (name === '_') {
            return;
        }

        if (SymbolNameUtils.isDunderName(name)) {
            return;
        }

        const decls = symbol.getDeclarations();
        decls.forEach(decl => {
            this._conditionallyReportUnusedDeclaration(decl,
                this._isSymbolPrivate(name, scopeType));
        });
    }

    private _conditionallyReportUnusedDeclaration(decl: Declaration, isPrivate: boolean) {
        let diagnosticLevel: DiagnosticLevel;
        let nameNode: NameNode | undefined;
        let message: string | undefined;
        let rule: DiagnosticRule | undefined;

        switch (decl.type) {
            case DeclarationType.Alias:
                diagnosticLevel = this._fileInfo.diagnosticSettings.reportUnusedImport;
                rule = DiagnosticRule.reportUnusedImport;
                if (decl.node.nodeType === ParseNodeType.ImportAs) {
                    if (decl.node.alias) {
                        nameNode = decl.node.alias;
                    } else {
                        // Handle multi-part names specially.
                        const nameParts = decl.node.module.nameParts;
                        if (nameParts.length > 0) {
                            const multipartName = nameParts.map(np => np.nameToken.value).join('.');
                            const textRange: TextRange = { start: nameParts[0].start, length: nameParts[0].length };
                            TextRange.extend(textRange, nameParts[nameParts.length - 1]);
                            this._fileInfo.diagnosticSink.addUnusedCodeWithTextRange(
                                `'${ multipartName }' is not accessed`, textRange);

                            this._evaluator.addDiagnostic(this._fileInfo.diagnosticSettings.reportUnusedImport,
                                DiagnosticRule.reportUnusedImport,
                                `Import '${ multipartName }' is not accessed`, textRange);
                            return;
                        }
                    }
                } else if (decl.node.nodeType === ParseNodeType.ImportFromAs) {
                    // Python files generated by protoc ("_pb2.py" files) contain
                    // unused imports. Don't report these because they're in generated
                    // files that shouldn't be edited.
                    const importFrom = decl.node.parent as ImportFromNode;
                    if (importFrom.module.nameParts.length === 0 ||
                            importFrom.module.nameParts[0].nameToken.value !== '__future__' &&
                            !this._fileInfo.filePath.endsWith('_pb2.py')) {

                        nameNode = decl.node.alias || decl.node.name;
                    }
                }

                if (nameNode) {
                    message = `Import '${ nameNode.nameToken.value }' is not accessed`;
                }
                break;

            case DeclarationType.Variable:
            case DeclarationType.Parameter:
                if (!isPrivate) {
                    return;
                }
                diagnosticLevel = this._fileInfo.diagnosticSettings.reportUnusedVariable;
                if (decl.node.nodeType === ParseNodeType.Name) {
                    nameNode = decl.node;
                    rule = DiagnosticRule.reportUnusedVariable;
                    message = `Variable '${ nameNode.nameToken.value }' is not accessed`;
                }
                break;

            case DeclarationType.Class:
                if (!isPrivate) {
                    return;
                }
                diagnosticLevel = this._fileInfo.diagnosticSettings.reportUnusedClass;
                nameNode = decl.node.name;
                rule = DiagnosticRule.reportUnusedClass;
                message = `Class '${ nameNode.nameToken.value }' is not accessed`;
                break;

            case DeclarationType.Function:
                if (!isPrivate) {
                    return;
                }
                diagnosticLevel = this._fileInfo.diagnosticSettings.reportUnusedFunction;
                nameNode = decl.node.name;
                rule = DiagnosticRule.reportUnusedFunction;
                message = `Function '${ nameNode.nameToken.value }' is not accessed`;
                break;

            default:
                return;
        }

        if (nameNode && rule !== undefined && message) {
            this._fileInfo.diagnosticSink.addUnusedCodeWithTextRange(
                `'${ nameNode.nameToken.value }' is not accessed`, nameNode);
            this._evaluator.addDiagnostic(diagnosticLevel, rule, message, nameNode);
        }
    }

    private _getAliasedSymbolTypeForName(name: string): Type | undefined {
        const symbolWithScope = this._currentScope.lookUpSymbolRecursive(name);
        if (!symbolWithScope) {
            return undefined;
        }

        const aliasDecl = symbolWithScope.symbol.getDeclarations().find(
            decl => decl.type === DeclarationType.Alias);
        if (!aliasDecl) {
            return undefined;
        }

        return DeclarationUtils.getInferredTypeOfDeclaration(aliasDecl, this._fileInfo.importLookup);
    }

    // Validates that a call to isinstance or issubclass are necessary. This is a
    // common source of programming errors.
    private _validateIsInstanceCallNecessary(node: CallNode) {
        if (this._fileInfo.diagnosticSettings.reportUnnecessaryIsInstance === 'none') {
            return;
        }

        // If this call is within an assert statement, we'll ignore it.
        let curNode: ParseNode | undefined = node;
        while (curNode) {
            if (curNode.nodeType === ParseNodeType.Assert) {
                return;
            }
            curNode = curNode.parent;
        }

        if (node.leftExpression.nodeType !== ParseNodeType.Name ||
                (node.leftExpression.nameToken.value !== 'isinstance' &&
                    node.leftExpression.nameToken.value !== 'issubclass') ||
                node.arguments.length !== 2) {
            return;
        }

        const callName = node.leftExpression.nameToken.value;
        const isInstanceCheck = callName === 'isinstance';
        const arg0Type = TypeUtils.doForSubtypes(
            this._getTypeOfExpression(node.arguments[0].valueExpression),
                subtype => {

            return TypeUtils.transformTypeObjectToClass(subtype);
        });

        if (isAnyOrUnknown(arg0Type)) {
            return;
        }

        const arg1Type = this._getTypeOfExpression(node.arguments[1].valueExpression);

        const classTypeList: ClassType[] = [];
        if (arg1Type.category === TypeCategory.Class) {
            classTypeList.push(arg1Type);
        } else if (arg1Type.category === TypeCategory.Object) {
            // The isinstance and issubclass call supports a variation where the second
            // parameter is a tuple of classes.
            const objClass = arg1Type.classType;
            if (ClassType.isBuiltIn(objClass, 'Tuple') && ClassType.getTypeArguments(objClass)) {
                ClassType.getTypeArguments(objClass)!.forEach(typeArg => {
                    if (typeArg.category === TypeCategory.Class) {
                        classTypeList.push(typeArg);
                    } else {
                        return;
                    }
                });
            }
        } else {
            return;
        }

        const finalizeFilteredTypeList = (types: Type[]): Type => {
            return combineTypes(types);
        };

        const filterType = (varType: ClassType): (ObjectType[] | ClassType[]) => {
            const filteredTypes: ClassType[] = [];

            for (const filterType of classTypeList) {
                const filterIsSuperclass = ClassType.isDerivedFrom(varType, filterType);
                const filterIsSubclass = ClassType.isDerivedFrom(filterType, varType);

                if (filterIsSuperclass) {
                    // If the variable type is a subclass of the isinstance
                    // filter, we haven't learned anything new about the
                    // variable type.
                    filteredTypes.push(varType);
                } else if (filterIsSubclass) {
                    // If the variable type is a superclass of the isinstance
                    // filter, we can narrow the type to the subclass.
                    filteredTypes.push(filterType);
                }
            }

            if (!isInstanceCheck) {
                return filteredTypes;
            }

            return filteredTypes.map(t => ObjectType.create(t));
        };

        let filteredType: Type;
        if (isInstanceCheck && arg0Type.category === TypeCategory.Object) {
            const remainingTypes = filterType(arg0Type.classType);
            filteredType = finalizeFilteredTypeList(remainingTypes);
        } else if (!isInstanceCheck && arg0Type.category === TypeCategory.Class) {
            const remainingTypes = filterType(arg0Type);
            filteredType = finalizeFilteredTypeList(remainingTypes);
        } else if (arg0Type.category === TypeCategory.Union) {
            let remainingTypes: Type[] = [];
            let foundAnyType = false;

            arg0Type.subtypes.forEach(t => {
                if (isAnyOrUnknown(t)) {
                    foundAnyType = true;
                }

                if (isInstanceCheck && t.category === TypeCategory.Object) {
                    remainingTypes = remainingTypes.concat(filterType(t.classType));
                } else if (!isInstanceCheck && t.category === TypeCategory.Class) {
                    remainingTypes = remainingTypes.concat(filterType(t));
                }
            });

            filteredType = finalizeFilteredTypeList(remainingTypes);

            // If we found an any or unknown type, all bets are off.
            if (foundAnyType) {
                return;
            }
        } else {
            return;
        }

        const getTestType = () => {
            const objTypeList = classTypeList.map(t => ObjectType.create(t));
            return combineTypes(objTypeList);
        };

        const callType = isInstanceCheck ? 'instance' : 'subclass';
        if (filteredType.category === TypeCategory.Never) {
            this._evaluator.addDiagnostic(
                this._fileInfo.diagnosticSettings.reportUnnecessaryIsInstance,
                DiagnosticRule.reportUnnecessaryIsInstance,
                `Unnecessary ${ callName } call: '${ printType(arg0Type) }' ` +
                    `is never ${ callType } of '${ printType(getTestType()) }'`,
                node);
        } else if (isTypeSame(filteredType, arg0Type)) {
            this._evaluator.addDiagnostic(
                this._fileInfo.diagnosticSettings.reportUnnecessaryIsInstance,
                DiagnosticRule.reportUnnecessaryIsInstance,
                `Unnecessary ${ callName } call: '${ printType(arg0Type) }' ` +
                    `is always ${ callType } of '${ printType(getTestType()) }'`,
                node);
        }
    }

    // Transforms the parameter type based on its category. If it's a simple parameter,
    // no transform is applied. If it's a var-arg or keyword-arg parameter, the type
    // is wrapped in a List or Dict.
    private _getVariadicParamType(paramCategory: ParameterCategory, type: Type): Type {
        if (paramCategory === ParameterCategory.VarArgList) {
            const listType = ScopeUtils.getBuiltInType(this._currentScope, 'List',
                this._fileInfo.importLookup);

            if (listType.category === TypeCategory.Class) {
                type = ObjectType.create(ClassType.cloneForSpecialization(listType, [type]));
            } else {
                type = UnknownType.create();
            }
        } else if (paramCategory === ParameterCategory.VarArgDictionary) {
            const dictType = ScopeUtils.getBuiltInType(this._currentScope, 'Dict',
                this._fileInfo.importLookup);
            const strType = ScopeUtils.getBuiltInObject(this._currentScope, 'str',
                this._fileInfo.importLookup);
            if (dictType.category === TypeCategory.Class && strType.category === TypeCategory.Object) {
                type = ObjectType.create(ClassType.cloneForSpecialization(dictType, [strType, type]));
            } else {
                type = UnknownType.create();
            }
        }

        return type;
    }

    private _isSymbolPrivate(nameValue: string, scopeType: ScopeType) {
        // All variables within the scope of a function or a list
        // comprehension are considered private.
        if (scopeType === ScopeType.Function || scopeType === ScopeType.ListComprehension) {
            return true;
        }

        // See if the symbol is private.
        if (SymbolNameUtils.isPrivateName(nameValue)) {
            return true;
        }

        if (SymbolNameUtils.isProtectedName(nameValue)) {
            // Protected names outside of a class scope are considered private.
            const isClassScope = scopeType === ScopeType.Class;
            return !isClassScope;
        }

        return false;
    }

    private _conditionallyReportPrivateUsage(node: NameNode) {
        if (this._fileInfo.diagnosticSettings.reportPrivateUsage === 'none') {
            return;
        }

        // Ignore privates in type stubs.
        if (this._fileInfo.isStubFile) {
            return;
        }

        const nameValue = node.nameToken.value;
        const isPrivateName = SymbolNameUtils.isPrivateName(nameValue);
        const isProtectedName = SymbolNameUtils.isProtectedName(nameValue);

        // If it's not a protected or private name, don't bother with
        // any further checks.
        if (!isPrivateName && !isProtectedName) {
            return;
        }

        const declarations = DeclarationUtils.getDeclarationsForNameNode(
            node, this._fileInfo.importLookup);

        let primaryDeclaration = declarations && declarations.length > 0 ?
            declarations[0] : undefined;
        if (!primaryDeclaration || primaryDeclaration.node === node) {
            return;
        }

        primaryDeclaration = DeclarationUtils.resolveAliasDeclaration(primaryDeclaration,
            this._fileInfo.importLookup);
        if (!primaryDeclaration || primaryDeclaration.node === node) {
            return;
        }

        let classOrModuleNode: ClassNode | ModuleNode | undefined;
        if (primaryDeclaration.node) {
            classOrModuleNode = ParseTreeUtils.getEnclosingClassOrModule(
            primaryDeclaration.node);
        }

        // If this is the name of a class, find the module or class that contains it rather
        // than constraining the use of the class name within the class itself.
        if (primaryDeclaration.node &&
                primaryDeclaration.node.parent &&
                primaryDeclaration.node.parent === classOrModuleNode &&
                classOrModuleNode.nodeType === ParseNodeType.Class) {

            classOrModuleNode = ParseTreeUtils.getEnclosingClassOrModule(classOrModuleNode);
        }

        // If it's a class member, check whether it's a legal protected access.
        let isProtectedAccess = false;
        if (classOrModuleNode && classOrModuleNode.nodeType === ParseNodeType.Class) {
            if (isProtectedName) {
                const declarationClassType = AnalyzerNodeInfo.getExpressionType(classOrModuleNode);
                if (declarationClassType && declarationClassType.category === TypeCategory.Class) {
                    // Note that the access is to a protected class member.
                    isProtectedAccess = true;

                    const enclosingClassNode = ParseTreeUtils.getEnclosingClass(node);
                    if (enclosingClassNode) {
                        isProtectedAccess = true;
                        const enclosingClassType = AnalyzerNodeInfo.getExpressionType(enclosingClassNode);

                        // If the referencing class is a subclass of the declaring class, it's
                        // allowed to access a protected name.
                        if (enclosingClassType && enclosingClassType.category === TypeCategory.Class) {
                            if (TypeUtils.derivesFromClassRecursive(enclosingClassType, declarationClassType)) {
                                return;
                            }
                        }
                    }
                }
            }
        }

        if (classOrModuleNode && !ParseTreeUtils.isNodeContainedWithin(node, classOrModuleNode)) {
            if (isProtectedAccess) {
                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportPrivateUsage,
                    DiagnosticRule.reportPrivateUsage,
                    `'${ nameValue }' is protected and used outside of a derived class`,
                    node);
            } else {
                const scopeName = classOrModuleNode.nodeType === ParseNodeType.Class ?
                    'class' : 'module';

                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportPrivateUsage,
                    DiagnosticRule.reportPrivateUsage,
                    `'${ nameValue }' is private and used outside of the ${ scopeName } in which it is declared`,
                    node);
            }
        }
    }

    // Verifies the rules specified in PEP 589 about TypedDict classes.
    // They cannot have statements other than type annotations, doc
    // strings, and "pass" statements or ellipses.
    private _validateTypedDictClassSuite(suiteNode: SuiteNode) {
        const emitBadStatementError = (node: ParseNode) => {
            this._evaluator.addError(`TypedDict classes can contain only type annotations`,
                node);
        };

        suiteNode.statements.forEach(statement => {
            if (!this._isCodeUnreachable(statement)) {
                if (statement.nodeType === ParseNodeType.StatementList) {
                    for (const substatement of statement.statements) {
                        if (substatement.nodeType !== ParseNodeType.TypeAnnotation &&
                                substatement.nodeType !== ParseNodeType.Ellipsis &&
                                substatement.nodeType !== ParseNodeType.StringList &&
                                substatement.nodeType !== ParseNodeType.Pass) {

                            emitBadStatementError(substatement);
                        }
                    }
                } else {
                    emitBadStatementError(statement);
                }
            }
        });
    }

    private _isCodeUnreachable(node: ParseNode): boolean {
        let curNode: ParseNode | undefined = node;

        // Walk up the parse tree until we find a node with
        // an associated flow node.
        while (curNode) {
            const flowNode = AnalyzerNodeInfo.getFlowNode(curNode);
            if (flowNode) {
                return !!(flowNode.flags & FlowFlags.Unreachable);
            }
            curNode = curNode.parent;
        }

        return false;
    }

    private _createAwaitableFunction(node: FunctionNode, functionType: FunctionType): FunctionType {
        const returnType = FunctionType.getEffectiveReturnType(functionType);

        let awaitableReturnType: Type | undefined;

        if (returnType.category === TypeCategory.Object) {
            const classType = returnType.classType;
            if (ClassType.isBuiltIn(classType)) {
                if (classType.details.name === 'Generator') {
                    // If the return type is a Generator, change it to an AsyncGenerator.
                    const asyncGeneratorType = this._evaluator.getTypingType(node, 'AsyncGenerator');
                    if (asyncGeneratorType && asyncGeneratorType.category === TypeCategory.Class) {
                        const typeArgs: Type[] = [];
                        const generatorTypeArgs = ClassType.getTypeArguments(classType);
                        if (generatorTypeArgs && generatorTypeArgs.length > 0) {
                            typeArgs.push(generatorTypeArgs[0]);
                        }
                        if (generatorTypeArgs && generatorTypeArgs.length > 1) {
                            typeArgs.push(generatorTypeArgs[1]);
                        }
                        awaitableReturnType = ObjectType.create(
                            ClassType.cloneForSpecialization(asyncGeneratorType, typeArgs));
                    }

                } else if (classType.details.name === 'AsyncGenerator') {
                    // If it's already an AsyncGenerator, leave it as is.
                    awaitableReturnType = returnType;
                }
            }
        }

        if (!awaitableReturnType) {
            const awaitableType = this._evaluator.getTypingType(node, 'Awaitable');
            if (awaitableType && awaitableType.category === TypeCategory.Class) {
                awaitableReturnType = ObjectType.create(
                    ClassType.cloneForSpecialization(awaitableType, [returnType]));
            } else {
                awaitableReturnType = UnknownType.create();
            }
        }

        // Clone the original function and replace its return type with an
        // Awaitable[<returnType>].
        const awaitableFunctionType = FunctionType.clone(functionType);
        FunctionType.setDeclaredReturnType(awaitableFunctionType, awaitableReturnType);

        return awaitableFunctionType;
    }

    private _validateFunctionReturn(node: FunctionNode, functionType: FunctionType) {
        // Stub files are allowed not to return an actual value,
        // so skip this if it's a stub file.
        if (this._fileInfo.isStubFile) {
            return;
        }

        const functionDecl = AnalyzerNodeInfo.getFunctionDeclaration(node)!;
        const declaredReturnType = FunctionType.isGenerator(functionType) ?
            TypeUtils.getDeclaredGeneratorReturnType(functionType) :
            FunctionType.getDeclaredReturnType(functionType);

        const functionNeverReturns = !this._evaluator.isAfterNodeReachable(node);
        const implicitlyReturnsNone = this._evaluator.isAfterNodeReachable(node.suite);

        if (node.returnTypeAnnotation) {
            // The types of all return statement expressions were already checked
            // against the declared type, but we need to verify the implicit None
            // at the end of the function.
            if (declaredReturnType && !functionNeverReturns && implicitlyReturnsNone) {
                if (TypeUtils.isNoReturnType(declaredReturnType)) {
                    // If the function consists entirely of "...", assume that it's
                    // an abstract method or a protocol method and don't require that
                    // the return type matches.
                    if (!ParseTreeUtils.isSuiteEmpty(node.suite)) {
                        this._evaluator.addError(`Function with declared type of 'NoReturn' cannot return 'None'`,
                            node.returnTypeAnnotation);
                    }
                } else if (!FunctionType.isAbstractMethod(functionType)) {
                    // Make sure that the function doesn't implicitly return None if the declared
                    // type doesn't allow it. Skip this check for abstract methods.
                    const diagAddendum = new DiagnosticAddendum();

                    // If the declared type isn't compatible with 'None', flag an error.
                    if (!TypeUtils.canAssignType(declaredReturnType, NoneType.create(),
                            diagAddendum, this._fileInfo.importLookup)) {

                        // If the function consists entirely of "...", assume that it's
                        // an abstract method or a protocol method and don't require that
                        // the return type matches.
                        if (!ParseTreeUtils.isSuiteEmpty(node.suite)) {
                            this._evaluator.addError(`Function with declared type of '${ printType(declaredReturnType) }'` +
                                    ` must return value` + diagAddendum.getString(),
                                node.returnTypeAnnotation);
                        }
                    }
                }
            }
        } else {
            if (FunctionType.isGenerator(functionType)) {
                // Infer the yield type.
                if (functionDecl.yieldExpressions) {
                    const inferredYieldTypes: Type[] = [];
                    functionDecl.yieldExpressions.forEach(yieldNode => {
                        if (this._evaluator.isNodeReachable(yieldNode)) {
                            if (yieldNode.expression) {
                                const cachedType = AnalyzerNodeInfo.getExpressionType(yieldNode.expression);
                                inferredYieldTypes.push(cachedType || UnknownType.create());
                            } else {
                                inferredYieldTypes.push(NoneType.create());
                            }
                        }
                    });

                    if (inferredYieldTypes.length > 0) {
                        let inferredYieldType = combineTypes(inferredYieldTypes);

                        // Inferred yield types need to be wrapped in a Generator to
                        // produce the final result.
                        const generatorType = this._evaluator.getTypingType(node, 'Generator');
                        if (generatorType && generatorType.category === TypeCategory.Class) {
                            inferredYieldType = ObjectType.create(
                                ClassType.cloneForSpecialization(generatorType, [inferredYieldType]));
                        } else {
                            inferredYieldType = UnknownType.create();
                        }

                        if (!functionType.details.inferredReturnType ||
                                !isTypeSame(functionType.details.inferredReturnType, inferredYieldType)) {

                            functionType.details.inferredReturnType = inferredYieldType;
                            this._setAnalysisChanged('Inferred yield type changed');
                        }
                    }
                }
            } else {
                // Infer the return type based on all of the return statements in the function's body.
                let inferredReturnType: Type;
                if (this._fileInfo.isStubFile) {
                    // If a return type annotation is missing in a stub file, assume
                    // it's an "unknown" type. In normal source files, we can infer the
                    // type from the implementation.
                    inferredReturnType = UnknownType.create();
                } else if (functionNeverReturns) {
                    // If the function always raises and never returns, assume a "NoReturn" type.
                    // Skip this for abstract methods which often are implemented with "raise
                    // NotImplementedError()".
                    if (FunctionType.isAbstractMethod(functionType)) {
                        inferredReturnType = UnknownType.create();
                    } else {
                        const noReturnClass = this._evaluator.getTypingType(node, 'NoReturn');
                        if (noReturnClass && noReturnClass.category === TypeCategory.Class) {
                            inferredReturnType = ObjectType.create(noReturnClass);
                        } else {
                            inferredReturnType = UnknownType.create();
                        }
                    }
                } else {
                    const inferredReturnTypes: Type[] = [];
                    if (functionDecl.returnExpressions) {
                        functionDecl.returnExpressions.forEach(returnNode => {
                            if (this._evaluator.isNodeReachable(returnNode)) {
                                if (returnNode.returnExpression) {
                                    const cachedType = AnalyzerNodeInfo.getExpressionType(returnNode.returnExpression);
                                    inferredReturnTypes.push(cachedType || UnknownType.create());
                                } else {
                                    inferredReturnTypes.push(NoneType.create());
                                }
                            }
                        });
                    }

                    if (!functionNeverReturns && implicitlyReturnsNone) {
                        inferredReturnTypes.push(NoneType.create());
                    }

                    inferredReturnType = combineTypes(inferredReturnTypes);
                }

                if (!functionType.details.inferredReturnType ||
                        !isTypeSame(functionType.details.inferredReturnType, inferredReturnType)) {

                    functionType.details.inferredReturnType = inferredReturnType;
                    this._setAnalysisChanged('Inferred return type changed');
                }

                if (inferredReturnType.category === TypeCategory.Unknown) {
                    this._evaluator.addDiagnostic(
                        this._fileInfo.diagnosticSettings.reportUnknownParameterType,
                        DiagnosticRule.reportUnknownParameterType,
                        `Inferred return type is unknown`, node.name);
                } else if (TypeUtils.containsUnknown(inferredReturnType)) {
                    this._evaluator.addDiagnostic(
                        this._fileInfo.diagnosticSettings.reportUnknownParameterType,
                        DiagnosticRule.reportUnknownParameterType,
                        `Return type '${ printType(inferredReturnType) }' is partially unknown`,
                        node.name);
                }
            }
        }
    }

    // Validates that any overridden methods contain the same signatures
    // as the original method. Also marks the class as abstract if one or
    // more abstract methods are not overridden.
    private _validateClassMethods(classType: ClassType) {
        if (TypeUtils.doesClassHaveAbstractMethods(classType, this._fileInfo.importLookup)) {
            ClassType.setIsAbstractClass(classType);
        }

        // Skip the overridden method check for stub files. Many of the built-in
        // typeshed stub files trigger this diagnostic.
        if (!this._fileInfo.isStubFile) {
            // Skip this check (which is somewhat expensive) if it is disabled.
            if (this._fileInfo.diagnosticSettings.reportIncompatibleMethodOverride !== 'none') {

                this._validateOveriddenMethods(classType);
            }
        }
    }

    private _validateOveriddenMethods(classType: ClassType) {
        ClassType.getFields(classType).forEach((symbol, name) => {
            // Don't check magic functions.
            if (symbol.isClassMember() && !SymbolNameUtils.isDunderName(name)) {
                const typeOfSymbol = getEffectiveTypeOfSymbol(symbol, this._fileInfo.importLookup);
                if (typeOfSymbol.category === TypeCategory.Function) {
                    const baseClassAndSymbol = TypeUtils.getSymbolFromBaseClasses(classType, name);
                    if (baseClassAndSymbol) {
                        const typeOfBaseClassMethod = getEffectiveTypeOfSymbol(
                            baseClassAndSymbol.symbol, this._fileInfo.importLookup);
                        const diagAddendum = new DiagnosticAddendum();
                        if (!TypeUtils.canOverrideMethod(typeOfBaseClassMethod, typeOfSymbol,
                                diagAddendum, this._fileInfo.importLookup)) {

                            const declarations = symbol.getDeclarations();
                            const errorNode = declarations[0].node;
                            if (errorNode) {
                                this._evaluator.addDiagnostic(
                                    this._fileInfo.diagnosticSettings.reportIncompatibleMethodOverride,
                                    DiagnosticRule.reportIncompatibleMethodOverride,
                                    `Method '${ name }' overrides class '${ baseClassAndSymbol.class.details.name }' ` +
                                        `in an incompatible manner` + diagAddendum.getString(), errorNode);
                            }
                        }
                    }
                }
            }
        });
    }

    // Transforms the input function type into an output type based on the
    // decorator function described by the decoratorNode.
    private _applyFunctionDecorator(inputFunctionType: Type, originalFunctionType: FunctionType,
            decoratorNode: DecoratorNode): Type {

        const decoratorType = this._getTypeOfExpression(decoratorNode.leftExpression);

        // Special-case the "overload" because it has no definition.
        if (decoratorType.category === TypeCategory.Class && decoratorType.details.name === 'overload') {
            if (inputFunctionType.category === TypeCategory.Function) {
                FunctionType.setIsOverloaded(inputFunctionType);
                return inputFunctionType;
            }
        }

        const returnType = this._evaluator.getTypeFromDecorator(decoratorNode, inputFunctionType);

        // Check for some built-in decorator types with known semantics.
        if (decoratorType.category === TypeCategory.Function) {
            if (FunctionType.getBuiltInName(decoratorType) === 'abstractmethod') {
                FunctionType.setIsAbstractMethod(originalFunctionType);
                return inputFunctionType;
            }

            // Handle property setters and deleters.
            if (decoratorNode.leftExpression.nodeType === ParseNodeType.MemberAccess) {
                const baseType = this._getTypeOfExpression(decoratorNode.leftExpression.leftExpression);
                if (baseType.category === TypeCategory.Property) {
                    const memberName = decoratorNode.leftExpression.memberName.nameToken.value;
                    if (memberName === 'setter') {
                        baseType.setter = originalFunctionType;
                        return baseType;
                    } else if (memberName === 'deleter') {
                        baseType.deleter = originalFunctionType;
                        return baseType;
                    }
                }
            }

        } else if (decoratorType.category === TypeCategory.Class) {
            if (ClassType.isBuiltIn(decoratorType)) {
                switch (decoratorType.details.name) {
                    case 'staticmethod': {
                        FunctionType.setIsStaticMethod(originalFunctionType);
                        return inputFunctionType;
                    }

                    case 'classmethod': {
                        FunctionType.setIsClassMethod(originalFunctionType);
                        return inputFunctionType;
                    }

                    case 'property':
                    case 'abstractproperty': {
                        if (inputFunctionType.category === TypeCategory.Function) {
                            // Allocate a property only during the first analysis pass.
                            // Otherwise the analysis won't converge if there are setters
                            // and deleters applied to the property.
                            const oldPropertyType = AnalyzerNodeInfo.getExpressionType(decoratorNode);
                            if (oldPropertyType) {
                                return oldPropertyType;
                            }
                            const newProperty = PropertyType.create(inputFunctionType);
                            AnalyzerNodeInfo.setExpressionType(decoratorNode, newProperty);
                            return newProperty;
                        }

                        break;
                    }
                }
            }
        }

        return returnType;
    }

    // Performs checks on a function that is located within a class
    // and has been determined not to be a property accessor.
    private _validateMethod(node: FunctionNode, functionType: FunctionType) {
        if (node.name && node.name.nameToken.value === '__new__') {
            // __new__ overrides should have a "cls" parameter.
            if (node.parameters.length === 0 || !node.parameters[0].name ||
                    (node.parameters[0].name.nameToken.value !== 'cls' &&
                    node.parameters[0].name.nameToken.value !== 'mcs')) {
                this._evaluator.addError(
                    `The __new__ override should take a 'cls' parameter`,
                    node.parameters.length > 0 ? node.parameters[0] : node.name);
            }
        } else if (node.name && node.name.nameToken.value === '__init_subclass__') {
            // __init_subclass__ overrides should have a "cls" parameter.
            if (node.parameters.length === 0 || !node.parameters[0].name ||
                    node.parameters[0].name.nameToken.value !== 'cls') {
                this._evaluator.addError(
                    `The __init_subclass__ override should take a 'cls' parameter`,
                    node.parameters.length > 0 ? node.parameters[0] : node.name);
            }
        } else if (FunctionType.isStaticMethod(functionType)) {
            // Static methods should not have "self" or "cls" parameters.
            if (node.parameters.length > 0 && node.parameters[0].name) {
                const paramName = node.parameters[0].name.nameToken.value;
                if (paramName === 'self' || paramName === 'cls') {
                    this._evaluator.addError(
                        `Static methods should not take a 'self' or 'cls' parameter`,
                        node.parameters[0].name);
                }
            }
        } else if (FunctionType.isClassMethod(functionType)) {
            let paramName = '';
            if (node.parameters.length > 0 && node.parameters[0].name) {
                paramName = node.parameters[0].name.nameToken.value;
            }
            // Class methods should have a "cls" parameter. We'll exempt parameter
            // names that start with an underscore since those are used in a few
            // cases in the stdlib pyi files.
            if (paramName !== 'cls') {
                if (!this._fileInfo.isStubFile || (!paramName.startsWith('_') && paramName !== 'metacls')) {
                    this._evaluator.addError(
                        `Class methods should take a 'cls' parameter`,
                        node.parameters.length > 0 ? node.parameters[0] : node.name);
                }
            }
        } else {
            // The presence of a decorator can change the behavior, so we need
            // to back off from this check if a decorator is present.
            if (node.decorators.length === 0) {
                let paramName = '';
                let firstParamIsSimple = true;
                if (node.parameters.length > 0) {
                    if (node.parameters[0].name) {
                        paramName = node.parameters[0].name.nameToken.value;
                    }

                    if (node.parameters[0].category !== ParameterCategory.Simple) {
                        firstParamIsSimple = false;
                    }
                }

                // Instance methods should have a "self" parameter. We'll exempt parameter
                // names that start with an underscore since those are used in a few
                // cases in the stdlib pyi files.
                if (firstParamIsSimple && paramName !== 'self' && !paramName.startsWith('_')) {
                    // Special-case the ABCMeta.register method in abc.pyi.
                    const isRegisterMethod = this._fileInfo.isStubFile &&
                        paramName === 'cls' &&
                        node.name.nameToken.value === 'register';

                    if (!isRegisterMethod) {
                        this._evaluator.addError(
                            `Instance methods should take a 'self' parameter`,
                            node.parameters.length > 0 ? node.parameters[0] : node.name);
                    }
                }
            }
        }
    }

    private _validateYieldType(node: YieldNode | YieldFromNode, adjustedYieldType: Type) {
        let declaredYieldType: Type | undefined;
        const enclosingFunctionNode = ParseTreeUtils.getEnclosingFunction(node);

        if (enclosingFunctionNode) {
            const functionType = AnalyzerNodeInfo.getExpressionType(
                enclosingFunctionNode) as FunctionType;
            if (functionType) {
                assert(functionType.category === TypeCategory.Function);
                const iteratorType = ScopeUtils.getBuiltInType(this._currentScope, 'Iterator',
                    this._fileInfo.importLookup);
                declaredYieldType = TypeUtils.getDeclaredGeneratorYieldType(functionType, iteratorType);
            }
        }

        if (this._isNodeReachable(node)) {
            if (declaredYieldType) {
                if (TypeUtils.isNoReturnType(declaredYieldType)) {
                    this._evaluator.addError(
                        `Function with declared return type 'NoReturn' cannot include a yield statement`,
                        node);
                } else {
                    const diagAddendum = new DiagnosticAddendum();
                    if (!TypeUtils.canAssignType(declaredYieldType, adjustedYieldType,
                            diagAddendum, this._fileInfo.importLookup)) {

                        this._evaluator.addError(
                            `Expression of type '${ printType(adjustedYieldType) }' cannot be assigned ` +
                                `to yield type '${ printType(declaredYieldType) }'` + diagAddendum.getString(),
                            node.expression || node);
                    }
                }
            }
        }
    }

    private _validateExceptionType(exceptionType: Type, errorNode: ParseNode) {
        const baseExceptionType = ScopeUtils.getBuiltInType(
            this._currentScope, 'BaseException', this._fileInfo.importLookup);

        const derivesFromBaseException = (classType: ClassType) => {
            if (!baseExceptionType || !(baseExceptionType.category === TypeCategory.Class)) {
                return true;
            }

            return TypeUtils.derivesFromClassRecursive(classType, baseExceptionType);
        };

        const diagAddendum = new DiagnosticAddendum();
        let isValidExceptionType = true;
        let resultingExceptionType: Type | undefined;

        if (isAnyOrUnknown(exceptionType)) {
            resultingExceptionType = exceptionType;
        } else if (exceptionType.category === TypeCategory.Class) {
            if (!derivesFromBaseException(exceptionType)) {
                isValidExceptionType = false;
                diagAddendum.addMessage(
                    `'${ printType(exceptionType) }' does not derive from BaseException`);
            }
            resultingExceptionType = ObjectType.create(exceptionType);
        } else if (exceptionType.category === TypeCategory.Object) {
            const iterableType = this._evaluator.getTypeFromIterable(
                exceptionType, false, errorNode, false);

            resultingExceptionType = TypeUtils.doForSubtypes(iterableType, subtype => {
                if (isAnyOrUnknown(subtype)) {
                    return subtype;
                }

                const transformedSubtype = TypeUtils.transformTypeObjectToClass(subtype);
                if (transformedSubtype.category === TypeCategory.Class) {
                    if (!derivesFromBaseException(transformedSubtype)) {
                        isValidExceptionType = false;
                        diagAddendum.addMessage(
                            `'${ printType(exceptionType) }' does not derive from BaseException`);
                    }

                    return ObjectType.create(transformedSubtype);
                }

                isValidExceptionType = false;
                diagAddendum.addMessage(
                    `'${ printType(exceptionType) }' does not derive from BaseException`);
                return UnknownType.create();
            });
        }

        if (!isValidExceptionType) {
            this._evaluator.addError(
                `'${ printType(exceptionType) }' is not valid exception class` +
                    diagAddendum.getString(),
                errorNode);
        }

        return resultingExceptionType || UnknownType.create();
    }

    private _isNodeReachable(node: ParseNode): boolean {
        return this._evaluator.isNodeReachable(node);
    }

    private _getTypeOfExpression(node: ExpressionNode, flags = EvaluatorFlags.None, expectedType?: Type): Type {
        return this._evaluator.getType(node, { method: 'get', expectedType }, flags);
    }

    private _evaluateExpressionForDeletion(node: ExpressionNode): Type {
        return this._evaluator.getType(node, { method: 'del' }, EvaluatorFlags.None);
    }

    // Validates that a new type declaration doesn't conflict with an
    // existing type declaration.
    private _validateDeclaredTypeMatches(node: ExpressionNode, type: Type,
            errorNode: ExpressionNode) {

        const declaredType = this._evaluator.getDeclaredTypeForExpression(node);
        if (declaredType) {
            if (!isTypeSame(declaredType, type)) {
                this._evaluator.addError(`Declared type '${ printType(type) }' is not compatible ` +
                    `with declared type '${ printType(declaredType) }'`,
                    errorNode);
            }
        }
    }

    // Given a function node and the function type associated with it, this
    // method search for prior function nodes that are marked as @overload
    // and creates an OverloadedFunctionType that includes this function and
    // all previous ones.
    private _addOverloadsToFunctionType(node: FunctionNode, type: FunctionType): Type {
        const symbolWithScope = this._currentScope.lookUpSymbolRecursive(node.name.nameToken.value);
        if (symbolWithScope) {
            const decls = symbolWithScope.symbol.getDeclarations();

            // Find this function's declaration.
            let declIndex = decls.findIndex(decl => {
                return (decl.type === DeclarationType.Function || decl.type === DeclarationType.Method) && decl.node === node;
            });
            if (declIndex > 0) {
                const overloadedTypes: OverloadedFunctionEntry[] = [{ type, typeSourceId: decls[declIndex].node.id }];
                while (declIndex > 0) {
                    const declType = AnalyzerNodeInfo.getExpressionType(decls[declIndex - 1].node);
                    if (!declType || declType.category !== TypeCategory.Function || !FunctionType.isOverloaded(declType)) {
                        break;
                    }

                    overloadedTypes.unshift({ type: declType, typeSourceId: decls[declIndex - 1].node.id });
                    declIndex--;
                }

                if (overloadedTypes.length > 1) {
                    // Create a new overloaded type that copies the contents of the previous
                    // one and adds a new function.
                    const newOverload = OverloadedFunctionType.create();
                    newOverload.overloads = overloadedTypes;
                    return newOverload;
                }
            }
        }

        return type;
    }

    private _enterScope(node: AnalyzerNodeInfo.ScopedNode, callback: () => void) {
        const prevScope = this._currentScope;
        const newScope = AnalyzerNodeInfo.getScope(node)!;
        assert(newScope !== undefined);

        this._currentScope = newScope;

        // Note that we found a scoped node.
        this._scopedNodes.push(node);

        callback();

        this._currentScope = prevScope;
    }

    private _setAnalysisChanged(reason: string) {
        this._didAnalysisChange = true;
        this._lastAnalysisChangeReason = reason;
    }
}
