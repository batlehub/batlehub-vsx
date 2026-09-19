package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.List;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.Expression;
import org.eclipse.jdt.core.dom.InfixExpression;
import org.eclipse.jdt.core.dom.MethodInvocation;
import org.eclipse.jdt.core.dom.NumberLiteral;
import org.eclipse.jdt.core.dom.PrefixExpression;

/** `x.size() == 0` (and `!= 0`, `> 0`, `0 == x.size()`) → `x.isEmpty()` / `!x.isEmpty()`. */
public final class SizeIsZero extends Base {
  public SizeIsZero() {
    super("collections", "sizeIsZero", "info");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(InfixExpression e) {
        MethodInvocation size = sizeCall(e.getLeftOperand());
        boolean flipped = false;
        if (size == null) {
          size = sizeCall(e.getRightOperand());
          flipped = true;
        }
        if (size == null || e.hasExtendedOperands()) return true;
        Expression other = flipped ? e.getLeftOperand() : e.getRightOperand();
        if (!(other instanceof NumberLiteral n) || !n.getToken().equals("0")) return true;
        InfixExpression.Operator op = e.getOperator();
        boolean empty;
        if (op == InfixExpression.Operator.EQUALS) empty = true;
        else if (op == InfixExpression.Operator.NOT_EQUALS) empty = false;
        else if (!flipped && op == InfixExpression.Operator.GREATER) empty = false;
        else if (flipped && op == InfixExpression.Operator.LESS) empty = false;
        else return true;
        final MethodInvocation call = size;
        final boolean isEmpty = empty;
        out.add(new Finding(SizeIsZero.this, e, "Use " + (empty ? "" : "!") + "isEmpty() instead of size() " + op + " 0", "Replace with " + (empty ? "" : "!") + "isEmpty()", rw -> {
          AST ast = e.getAST();
          MethodInvocation m = ast.newMethodInvocation();
          m.setName(ast.newSimpleName("isEmpty"));
          if (call.getExpression() != null) m.setExpression((Expression) rw.createCopyTarget(call.getExpression()));
          Expression replacement = m;
          if (!isEmpty) {
            PrefixExpression not = ast.newPrefixExpression();
            not.setOperator(PrefixExpression.Operator.NOT);
            not.setOperand(m);
            replacement = not;
          }
          rw.replace(e, replacement, null);
        }));
        return true;
      }
    });
  }

  private static MethodInvocation sizeCall(Expression e) {
    return e instanceof MethodInvocation m && m.getName().getIdentifier().equals("size") && m.arguments().isEmpty() ? m : null;
  }
}
